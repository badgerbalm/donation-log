'use strict';

const storageKey = 'csl-donation-visits-v1';
const apiBase = 'https://donation-log-api.onlinesny.workers.dev/api';
const donationSessionKey = 'donation-log-google-session-v1';
const pendingAuthKey = 'donation-log-google-pending-v1';
const authBase = 'https://daily-workout-auth.onlinesny.workers.dev';
const fields = ['systolic', 'diastolic', 'pulse', 'weight', 'temperature', 'hematocrit', 'protein', 'duration'];
const columns = ['date', 'time', 'visitType', ...fields, 'arm', 'notes', 'source'];
const form = document.querySelector('#visit');
const status = document.querySelector('#status');
const historyStatus = document.querySelector('#history-status');
const history = document.querySelector('#history');
const cancel = document.querySelector('#cancel');
const heading = document.querySelector('#form-title');
let editing = null;
let creatingNew = false;
let records = [];
let canWrite = true;
let medicationEvents = [];
let visitsLoadState = 'loading';
let visitsLoadError = '';
let activeTrend = 'bp';
let bpChartRange = 'all';

function savedSession() {
  try {
    const value = JSON.parse(localStorage.getItem(donationSessionKey) || 'null');
    return value?.expires * 1000 > Date.now() && typeof value.session === 'string' ? value : null;
  } catch { return null; }
}

function randomAuthValue() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function setConnectionStatus(message) {
  document.querySelectorAll('.connection-status').forEach(node => { node.textContent = message; });
}

async function startDonationSignIn() {
  const buttons = [...document.querySelectorAll('.connect-google')];
  buttons.forEach(button => { button.disabled = true; });
  setConnectionStatus('Opening secure Google sign-in…');
  try {
    const verifier = randomAuthValue();
    const state = randomAuthValue();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    sessionStorage.setItem(pendingAuthKey, JSON.stringify({ verifier, state, created: Date.now() }));
    const response = await fetch(authBase + '/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, state, app: 'donation' }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
    const detail = await response.json().catch(() => ({}));
    if (!response.ok || typeof detail.url !== 'string') throw new Error(detail.error || 'Could not start Google sign-in.');
    location.assign(detail.url);
  } catch (error) {
    setConnectionStatus(error.message || 'Could not start Google sign-in. Try again.');
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function restoreDonationSignIn() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('donation_auth') || params.has('donation_auth_error')) {
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem(pendingAuthKey) || 'null'); } catch {}
    location.hash = '';
    if (!pending || pending.state !== params.get('donation_state') || Date.now() - pending.created > 900000) {
      sessionStorage.removeItem(pendingAuthKey);
      throw new Error('Google returned to a different browser context. Tap Sign in to Donation Log and try again.');
    }
    if (params.has('donation_auth_error')) {
      sessionStorage.removeItem(pendingAuthKey);
      throw new Error('Google sign-in was cancelled.');
    }
    const response = await fetch(authBase + '/auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: params.get('donation_auth'), verifier: pending.verifier }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
    const detail = await response.json().catch(() => ({}));
    if (!response.ok || typeof detail.session !== 'string') throw new Error(detail.error || 'Google sign-in could not be completed.');
    localStorage.setItem(donationSessionKey, JSON.stringify(detail));
    sessionStorage.removeItem(pendingAuthKey);
  }

  const session = savedSession();
  if (!session) return false;
  const response = await fetch(authBase + '/session', {
    headers: { Authorization: 'Bearer ' + session.session },
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer'
  });
  if (response.status === 401) {
    localStorage.removeItem(donationSessionKey);
    return false;
  }
  if (!response.ok) throw new Error('Could not verify your Donation Log sign-in.');
  return true;
}

async function apiRequest(path, options = {}) {
  const session = savedSession();
  if (!session) throw new Error('Sign in to Donation Log to load your private visits.');
  const response = await fetch(apiBase + path, {
    ...options,
    cache: 'no-store',
    headers: { ...(options.headers || {}), Authorization: 'Bearer ' + session.session }
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || (response.status === 401 ? 'Your Donation Log sign-in expired. Sign in again here.' : 'The Donation Log database is unavailable.'));
  }
  return response;
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

function normalize(input) {
  if (!input || !validDate(input.date) || (input.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))) {
    throw new Error('Enter a valid visit date and time.');
  }
  const defaultVisitType = input.source === 'Personal BP log' ? 'Other BP reading' : 'CSL donation';
  const row = { id: input.id || (input.date + ' ' + (input.time || '')), date: input.date, time: input.time || '', visitType: input.visitType || defaultVisitType, arm: input.arm || '', notes: input.notes || '', source: input.source || 'Manual entry' };
  if (!['CSL donation', 'Doctor / clinic', 'Home reading', 'Other BP reading', 'Other'].includes(row.visitType) || !['', 'Left', 'Right', 'Both'].includes(row.arm) || typeof row.notes !== 'string' || row.notes.length > 2000) {
    throw new Error('Check the arm and visit notes.');
  }
  for (const field of fields) {
    const value = input[field];
    const number = value === '' || value == null ? null : Number(value);
    const whole = ['systolic', 'diastolic', 'pulse'].includes(field);
    if (number !== null && (!['string','number'].includes(typeof value) || !Number.isFinite(number) ||
      number < 0 || (whole && (!Number.isInteger(number) || number < 1 || number > 400)) ||
      (field === 'hematocrit' && number > 100) || (field === 'protein' && (number < 5.5 || number > 9.5)) || (['weight','temperature'].includes(field) && number <= 0))) {
      throw new Error('Check the value for ' + field + '.');
    }
    row[field] = number;
  }
  if (row.systolic !== null && row.diastolic !== null && row.systolic <= row.diastolic) {
    throw new Error('Systolic pressure must be higher than diastolic pressure.');
  }
  return row;
}

function visitKey(row) { return row.id || row.date + ' ' + row.time; }
function dateTimeKey(row) { return row.date + ' ' + (row.time || ''); }
function localToday() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}
function defaultArm() {
  const latest = records.filter(row => row.visitType === 'CSL donation' && (row.arm === 'Left' || row.arm === 'Right')).sort((a,b) => dateTimeKey(b).localeCompare(dateTimeKey(a)))[0];
  if (latest?.arm === 'Left') return 'Right';
  if (latest?.arm === 'Right') return 'Left';
  return '';
}

async function save(next, options = {}) {
  if (!canWrite) throw new Error('Existing browser storage could not be read. Changes are disabled.');
  await apiRequest('/visits',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({records:next,replace:options.replace===true})});
  try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
  records = next;
  render();
  if (typeof drawReport === 'function') drawReport();
}

async function deleteVisit(row) {
  const key = visitKey(row);
  const label = new Date(row.date + 'T12:00:00').toLocaleDateString() + (row.time ? ' at ' + row.time : '') + ' · ' + row.visitType;
  if (!window.confirm('Permanently delete this visit?\n\n' + label)) return;
  try {
    const result = await apiRequest('/visits', {method:'DELETE', headers:{'content-type':'application/json'}, body:JSON.stringify({id:key})});
    const detail = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(detail.error || 'Could not delete this visit from the shared database.');
    if (!detail.deleted) throw new Error('This visit was not found in the shared database. Refresh the visit list and try again.');
    records = records.filter(item => visitKey(item) !== key);
    try { localStorage.setItem(storageKey, JSON.stringify(records)); } catch {}
    render();
    if (typeof drawReport === 'function') drawReport();
    const message = 'Deleted visit for ' + label + '.';
    historyStatus.textContent = message;
    if (!document.querySelector('#pending-visits').hidden) document.querySelector('#dashboard-status').textContent = message;
  } catch (error) {
    historyStatus.textContent = error.message;
  }
}

async function loadSharedRecords(data) {
  if(!Array.isArray(data.records))throw new Error('The database returned an invalid visit list.');
  const loaded=data.records.map(normalize);
  let correctedLabels=0;
  for(const row of loaded){
    const legacyHematocrit=Number.isFinite(row.iron)&&row.iron>=35&&row.iron<=60;
    if(row.source==='workbook'&&row.hematocrit===null&&legacyHematocrit){
      row.hematocrit=row.iron;
      row.iron=null;
      correctedLabels++;
    } else if(row.source==='workbook'&&row.protein===null&&Number.isFinite(row.iron)&&row.iron>=6&&row.iron<=9){
      row.protein=row.iron;
      row.iron=null;
      correctedLabels++;
    }
  }
  const importedKeys=new Set(loaded.filter(row=>row.source!=='Manual entry').map(dateTimeKey));
  const cleaned=loaded.filter(row=>!(row.source==='Manual entry'&&row.id===dateTimeKey(row)&&importedKeys.has(dateTimeKey(row))));
  records=cleaned;render();drawReport();
  if(!editing) form.elements.arm.value=defaultArm();
  if(cleaned.length!==loaded.length||correctedLabels){
    const removed=loaded.length-cleaned.length;
    await save(cleaned,{replace:true});
    const messages=['Loaded '+cleaned.length+' visits'];
    if(correctedLabels)messages.push('corrected Hematocrit and Total protein labels on '+correctedLabels+' spreadsheet rows');
    if(removed)messages.push('removed '+removed+' duplicate legacy copies');
    historyStatus.textContent=messages.join('; ')+'.';
  }
}

function resetForm() {
  form.reset();
  editing = null;
  heading.textContent = 'New visit';
  cancel.hidden = true;
  form.elements.arm.value = defaultArm();
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  form.elements.date.value = now.toISOString().slice(0, 10);
  form.elements.visitType.value = 'CSL donation';
  renderEntryDashboard();
}

function startEditing(row) {
  editing = visitKey(row);
  creatingNew = false;
  for (const field of columns) if (form.elements[field]) form.elements[field].value = row[field] ?? '';
  heading.textContent = needsDonationDetails(row) ? 'Complete visit' : 'Edit visit';
  cancel.hidden = false;
  status.textContent = 'Add the donation time and any readings from the CSL screenshot, then save to update this same visit.';
  document.querySelectorAll('[data-page-panel]').forEach(panel => panel.hidden = panel.dataset.pagePanel !== 'entry');
  document.querySelectorAll('.menu-link').forEach(link => link.classList.toggle('active', link.dataset.page === 'entry'));
  form.elements.time.focus();
  renderEntryDashboard();
}

function needsDonationDetails(row) {
  return row.visitType === 'CSL donation' && !row.time && row.arm && (row.hematocrit !== null || row.protein !== null) &&
    row.systolic === null && row.diastolic === null && row.pulse === null && row.weight === null && row.temperature === null;
}

function renderEntryDashboard() {
  const panel = document.querySelector('#pending-visits');
  if (!panel) return;
  const todaysVisits = records.filter(row => row.date === localToday()).sort((a,b) => dateTimeKey(b).localeCompare(dateTimeKey(a)));
  const showDashboard = editing === null && !creatingNew;
  panel.hidden = !showDashboard;
  document.querySelector('#entry-editor').hidden = !editing && !creatingNew;
  const list = document.querySelector('#pending-list');
  list.replaceChildren();
  if (!todaysVisits.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No visits recorded today.';
    list.append(empty);
  }
  for (const row of todaysVisits) {
    const item = document.createElement('div');
    item.className = 'pending-visit';
    const summary = document.createElement('p');
    const details = [row.time || 'Time not entered', row.visitType];
    if (row.arm) details.push('Arm ' + row.arm);
    if (row.hematocrit !== null) details.push('Hematocrit ' + row.hematocrit);
    if (row.protein !== null) details.push('Total protein ' + row.protein + ' g/dL');
    if (row.systolic !== null && row.diastolic !== null) details.push('BP ' + row.systolic + '/' + row.diastolic);
    if (row.pulse !== null) details.push('Pulse ' + row.pulse);
    if (row.weight !== null) details.push('Weight ' + row.weight + ' lb');
    if (row.temperature !== null) details.push('Temp ' + row.temperature + ' °F');
    details.unshift(new Date(row.date + 'T12:00:00').toLocaleDateString());
    summary.textContent = details.join(' · ');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = needsDonationDetails(row) ? 'Add additional details' : 'Edit visit';
    button.addEventListener('click', () => startEditing(row));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete visit ' + row.date + (row.time ? ' at ' + row.time : ''));
    remove.addEventListener('click', () => deleteVisit(row));
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(button, remove);
    item.append(summary, actions);
    list.append(item);
  }
}

function render() {
  history.replaceChildren();
  renderHistoryTable();
  renderHistoryChart();
  drawMetricTrend();
  renderEntryDashboard();
  if (!records.length) {
    if (canWrite) historyStatus.textContent = 'No visits saved yet.';
    return;
  }
  historyStatus.textContent = records.length + (records.length === 1 ? ' visit saved' : ' visits saved');
  for (const row of [...records].sort((a,b) => visitKey(b).localeCompare(visitKey(a)))) {
    const item = document.createElement('li');
    const text = document.createElement('div');
    const title = document.createElement('strong');
    const details = document.createElement('span');
    title.textContent = visitKey(row).trim();
    const readings = [];
    if (row.systolic !== null || row.diastolic !== null) readings.push((row.systolic ?? '—') + '/' + (row.diastolic ?? '—') + ' mm Hg');
    if (row.pulse !== null) readings.push(row.pulse + ' bpm');
    if (row.weight !== null) readings.push(row.weight + ' lb');
    details.textContent = readings.join(' · ') || 'Visit details';
    text.append(title, details);
    const edit = document.createElement('button');
    edit.textContent = needsDonationDetails(row) ? 'Add donation details' : 'Edit';
    edit.className = 'secondary';
    edit.setAttribute('aria-label', 'Edit visit ' + title.textContent);
    edit.addEventListener('click', () => startEditing(row));
    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.className = 'secondary';
    remove.setAttribute('aria-label', 'Delete visit ' + title.textContent);
    remove.addEventListener('click', () => deleteVisit(row));
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(edit, remove);
    item.append(text, actions);
    history.append(item);
  }
}

function renderHistoryTable(){
  const body=document.querySelector('#history-table tbody');body.replaceChildren();
  for(const row of [...records].sort((a,b)=>visitKey(b).localeCompare(visitKey(a)))){
    const tr=document.createElement('tr');
    const values=[row.date,row.visitType,(row.systolic??'')+'/'+(row.diastolic??''),row.pulse,row.weight,row.temperature,row.hematocrit,row.protein,[row.arm,row.duration===null?'':row.duration+' min'].filter(Boolean).join(' · '),row.notes];
    for(const value of values){const td=document.createElement('td');td.textContent=value===null?'':String(value);tr.append(td);}
    body.append(tr);
  }
}

function renderHistoryChart(){
  const svg=document.querySelector('#history-chart');
  svg.replaceChildren();
  svg.setAttribute('viewBox','0 0 760 650');
  const dated=records.filter(row=>validDate(row.date)).sort((a,b)=>a.date.localeCompare(b.date));
  if(!dated.length){
    svg.setAttribute('aria-label','No saved visits yet');
    const empty=document.createElementNS('http://www.w3.org/2000/svg','text');
    empty.setAttribute('x','20');empty.setAttribute('y','42');empty.setAttribute('fill','#4d6364');
    empty.textContent='No saved visits to chart yet.';
    svg.append(empty);
    return;
  }
  const ns='http://www.w3.org/2000/svg';
  const first=Date.parse(dated[0].date+'T00:00:00Z');
  const last=Date.parse(dated.at(-1).date+'T00:00:00Z');
  const xDate=date=>72+(last===first?0:(Date.parse(date+'T00:00:00Z')-first)/(last-first)*672);
  const panels=[
    {name:'Blood pressure',unit:'mm Hg',top:42,bottom:205,fields:[['systolic','Systolic','#b4422e'],['diastolic','Diastolic','#236a83']],low:40,high:200,step:40},
    {name:'Weight',unit:'lb',top:248,bottom:335,fields:[['weight','Weight','#518250']],low:140,high:220,step:20},
    {name:'Hematocrit',unit:'%',top:378,bottom:465,fields:[['hematocrit','Hematocrit','#916c25']],low:30,high:65,step:5},
    {name:'Total protein',unit:'g/dL',top:508,bottom:595,fields:[['protein','Total protein','#7654a5']],low:5,high:10,step:1}
  ];
  const allValues=dated.flatMap(row=>panels.flatMap(panel=>panel.fields.map(([field])=>row[field]).filter(Number.isFinite)));
  svg.setAttribute('aria-label','Historical donation measurements in separate panels: blood pressure, weight, hematocrit, and total protein. Each panel has its own labeled scale.');
  for(const panel of panels){
    const values=dated.flatMap(row=>panel.fields.map(([field])=>row[field]).filter(Number.isFinite));
    let low=panel.low,high=panel.high;
    if(values.length){
      low=Math.min(low,Math.floor(Math.min(...values)/panel.step)*panel.step);
      high=Math.max(high,Math.ceil(Math.max(...values)/panel.step)*panel.step);
      if(low===high)high=low+panel.step;
    }
    const label=document.createElementNS(ns,'text');
    label.setAttribute('x','8');label.setAttribute('y',String(panel.top+12));label.setAttribute('font-size','13');label.setAttribute('font-weight','700');label.setAttribute('fill','#17252b');
    label.textContent=panel.name+' ('+panel.unit+')';svg.append(label);
    for(let value=low;value<=high+panel.step/100;value+=panel.step){
      const y=panel.bottom-(value-low)/(high-low)*(panel.bottom-panel.top);
      const grid=document.createElementNS(ns,'line');grid.setAttribute('x1','68');grid.setAttribute('x2','748');grid.setAttribute('y1',String(y));grid.setAttribute('y2',String(y));grid.setAttribute('stroke','#d8e2df');grid.setAttribute('stroke-width','1');svg.append(grid);
      const tick=document.createElementNS(ns,'text');tick.setAttribute('x','62');tick.setAttribute('y',String(y+4));tick.setAttribute('text-anchor','end');tick.setAttribute('font-size','11');tick.setAttribute('fill','#4d6364');tick.textContent=String(Number(value.toFixed(1)));svg.append(tick);
    }
    for(const [field,name,color] of panel.fields){
      const vals=dated.filter(row=>Number.isFinite(row[field]));
      if(!vals.length)continue;
      const points=vals.map(row=>{
        const y=panel.bottom-(row[field]-low)/(high-low)*(panel.bottom-panel.top);
        return xDate(row.date)+','+y;
      }).join(' ');
      const line=document.createElementNS(ns,'polyline');
      line.setAttribute('points',points);line.setAttribute('fill','none');line.setAttribute('stroke',color);line.setAttribute('stroke-width',panel.fields.length>1?'2.6':'2.4');line.setAttribute('stroke-linejoin','round');line.setAttribute('stroke-linecap','round');
      const title=document.createElementNS(ns,'title');title.textContent=name+' trend';line.append(title);svg.append(line);
    }
  }
  const yearStart=Number(dated[0].date.slice(0,4)),yearEnd=Number(dated.at(-1).date.slice(0,4));
  const years=[];
  for(let year=yearStart;year<=yearEnd;year++)years.push(year);
  const yearStride=years.length>8?2:1;
  const axis=document.createElementNS(ns,'line');axis.setAttribute('x1','72');axis.setAttribute('x2','744');axis.setAttribute('y1','615');axis.setAttribute('y2','615');axis.setAttribute('stroke','#617777');axis.setAttribute('stroke-width','1');svg.append(axis);
  years.forEach((year,index)=>{
    if(index%yearStride!==0&&year!==yearEnd)return;
    const x=Math.max(72,Math.min(744,xDate(year+'-01-01')));
    const mark=document.createElementNS(ns,'line');mark.setAttribute('x1',String(x));mark.setAttribute('x2',String(x));mark.setAttribute('y1','615');mark.setAttribute('y2','620');mark.setAttribute('stroke','#617777');svg.append(mark);
    const label=document.createElementNS(ns,'text');label.setAttribute('x',String(x));label.setAttribute('y','645');label.setAttribute('text-anchor','middle');label.setAttribute('font-size','11');label.setAttribute('fill','#4d6364');label.textContent=String(year);svg.append(label);
  });
  const legend=document.createElementNS(ns,'text');legend.setAttribute('x','748');legend.setAttribute('y','20');legend.setAttribute('text-anchor','end');legend.setAttribute('font-size','11');legend.setAttribute('fill','#4d6364');legend.textContent=allValues.length+' measurements';svg.append(legend);
}


const trendSpecs = {
  bp: { title: 'Blood pressure trend', unit: 'mm Hg', fields: [['systolic','Systolic','#b4422e'],['diastolic','Diastolic','#236a83']], fixed: [40,200,20] },
  weight: { title: 'Weight trend', unit: 'lb', fields: [['weight','Weight','#518250']], step: 2, minSpan: 10, decimals: 1 },
  hematocrit: { title: 'Hematocrit trend', unit: '%', fields: [['hematocrit','Hematocrit','#916c25']], step: 2, minSpan: 8, decimals: 0 },
  protein: { title: 'Total protein trend', unit: 'g/dL', fields: [['protein','Total protein','#7654a5']], step: 0.2, minSpan: 1, decimals: 1 },
  temperature: { title: 'Temperature trend', unit: '°F', fields: [['temperature','Temperature','#c4663a']], step: 0.5, minSpan: 2, decimals: 1 }
};

function trendNumber(value, decimals) {
  return Number(value).toFixed(decimals);
}

function trendDateLabel(date, includeYear = true) {
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(includeYear ? {year:'numeric'} : {})
  });
}

function drawMetricTrend() {
  const spec = trendSpecs[activeTrend] || trendSpecs.bp;
  const title = document.querySelector('#trend-title');
  const description = document.querySelector('#trend-description');
  const summary = document.querySelector('#trend-summary');
  const empty = document.querySelector('#trend-empty');
  const wrap = document.querySelector('#trend-chart-wrap');
  const svg = document.querySelector('#metric-trend-chart');
  if (!title || !svg) return;
  title.textContent = spec.title;
  description.textContent = activeTrend === 'bp'
    ? 'Recorded blood pressure over time. Donation screening readings may not be resting or home readings.'
    : 'Recorded ' + spec.title.replace(/ trend$/, '').toLowerCase() + ' measurements over time.';

  const period = document.querySelector('#trend-range')?.value || 'all';
  let cutoff = '';
  if (period !== 'all') {
    const years = period === '1y' ? 1 : 5;
    const date = new Date();
    date.setFullYear(date.getFullYear() - years);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    cutoff = date.toISOString().slice(0, 10);
  }
  const fieldNames = spec.fields.map(field => field[0]);
  let readings = records.filter(row => validDate(row.date) && (!cutoff || row.date >= cutoff));
  if (activeTrend === 'bp') readings = readings.filter(row => Number.isFinite(row.systolic) && Number.isFinite(row.diastolic));
  else readings = readings.filter(row => Number.isFinite(row[fieldNames[0]]));
  readings.sort((a,b) => (a.date + ' ' + (a.time || '')).localeCompare(b.date + ' ' + (b.time || '')));

  svg.replaceChildren();
  svg.setAttribute('viewBox','0 0 820 370');
  svg.setAttribute('aria-label',spec.title + ' in ' + spec.unit);
  if (!readings.length) {
    summary.textContent = 'No ' + spec.title.replace(/ trend$/, '').toLowerCase() + ' readings in this period.';
    empty.textContent = activeTrend === 'protein'
      ? 'No total protein readings recorded yet. Add a value during a CSL visit to start this trend.'
      : 'Add a visit with this measurement to see its trend.';
    empty.hidden = false;
    wrap.hidden = true;
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  const dateRange = readings.map(row => Date.parse(row.date + 'T' + (row.time || '12:00') + ':00'));
  const first = Math.min(...dateRange), last = Math.max(...dateRange);
  const x = value => 72 + (last === first ? 0.5 : (value - first) / (last - first)) * 710;
  const values = readings.flatMap(row => fieldNames.map(field => row[field]).filter(Number.isFinite));
  let low, high, step;
  if (spec.fixed) [low, high, step] = spec.fixed;
  else {
    step = spec.step;
    const rawLow = Math.min(...values), rawHigh = Math.max(...values);
    const span = Math.max(rawHigh - rawLow, spec.minSpan);
    const pad = Math.max(span * 0.12, step * 1.5);
    low = Math.floor((rawLow - pad) / step) * step;
    high = Math.ceil((rawHigh + pad) / step) * step;
    if (high <= low) high = low + step;
  }
  const top = 34, bottom = 292;
  const y = value => bottom - ((value - low) / (high - low)) * (bottom - top);
  const ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [key,value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  const tickCount = 5;
  for (let i=0;i<=tickCount;i++) {
    const value = low + (high-low)*i/tickCount, yy = y(value);
    add('line',{x1:66,x2:800,y1:yy,y2:yy,stroke:'#d8e2df'});
    add('text',{x:58,y:yy+4,'text-anchor':'end','font-size':12,fill:'#4d6364'},trendNumber(value,spec.decimals ?? 0));
  }
  add('line',{x1:70,x2:800,y1:bottom,y2:bottom,stroke:'#617777'});
  const showYearLabels = last - first > 330 * 24 * 60 * 60 * 1000;
  const labelCount = Math.min(5, readings.length);
  for(let i=0;i<labelCount;i++){
    const index = labelCount===1 ? readings.length-1 : Math.round(i*(readings.length-1)/(labelCount-1));
    const row = readings[index], xx = x(dateRange[index]);
    add('line',{x1:xx,x2:xx,y1:bottom,y2:bottom+5,stroke:'#617777'});
    add('text',{x:xx,y:bottom+25,'text-anchor':'middle','font-size':11,fill:'#4d6364'},trendDateLabel(row.date,showYearLabels));
  }
  for(const [field,name,color] of spec.fields){
    const series = readings.filter(row=>Number.isFinite(row[field]));
    if(!series.length)continue;
    const points = series.map(row=>x(Date.parse(row.date+'T'+(row.time||'12:00')+':00'))+','+y(row[field])).join(' ');
    add('polyline',{points,fill:'none',stroke:color,'stroke-width':2.8,'stroke-linejoin':'round','stroke-linecap':'round'});
    for(const row of series){
      const circle=add('circle',{cx:x(Date.parse(row.date+'T'+(row.time||'12:00')+':00')),cy:y(row[field]),r:4,fill:color});
      const pointTitle=document.createElementNS(ns,'title');
      pointTitle.textContent=trendDateLabel(row.date)+': '+name+' '+trendNumber(row[field],spec.decimals ?? 0)+' '+spec.unit;
      circle.append(pointTitle);
    }
  }
  if(spec.fields.length>1){
    let legendX=70;
    for(const [field,name,color] of spec.fields){
      const count=readings.filter(row=>Number.isFinite(row[field])).length;
      add('circle',{cx:legendX+4,cy:345,r:4,fill:color});
      add('text',{x:legendX+13,y:349,'font-size':12,fill:'#34494b'},name+' · '+count);
      legendX+=125;
    }
  }
  if(activeTrend==='bp'){
    const latest=readings.at(-1);
    const systolic=readings.map(row=>row.systolic),diastolic=readings.map(row=>row.diastolic);
    summary.textContent='Latest '+latest.systolic+'/'+latest.diastolic+' mm Hg on '+trendDateLabel(latest.date)+
      ' · '+readings.length+' readings · systolic '+Math.min(...systolic)+'–'+Math.max(...systolic)+
      ' · diastolic '+Math.min(...diastolic)+'–'+Math.max(...diastolic);
  } else {
    const field=fieldNames[0],latest=readings.at(-1),measurements=readings.map(row=>row[field]);
    summary.textContent='Latest '+trendNumber(latest[field],spec.decimals)+' '+spec.unit+' on '+trendDateLabel(latest.date)+
      ' · '+readings.length+' readings · range '+trendNumber(Math.min(...measurements),spec.decimals)+'–'+
      trendNumber(Math.max(...measurements),spec.decimals)+' '+spec.unit;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const input=Object.fromEntries(new FormData(form));
    if(editing){const original=records.find(record=>visitKey(record)===editing);input.id=original?.id;input.source=original?.source;}
    const row = normalize(input);
    const next = records.filter(record => visitKey(record) !== editing);
    if (next.some(record => visitKey(record) === visitKey(row))) {
      throw new Error('A visit already uses this date and time. Edit that visit or enter a different time.');
    }
    const wasEditing = editing !== null;
    const isPreDonationScreen = !row.time && row.visitType === 'CSL donation' && row.arm && (row.hematocrit !== null || row.protein !== null) && row.systolic === null && row.diastolic === null && row.pulse === null && row.weight === null && row.temperature === null;
    await save([...next, row]);
    creatingNew = false;
    resetForm();
    const saveMessage = wasEditing ? 'Updated visit for ' + row.date + '.' :
      (isPreDonationScreen
        ? 'Pre-donation screening saved. Add additional details here after the donation.'
        : 'Saved visit for ' + row.date + '.');
    status.textContent = saveMessage;
    document.querySelector('#dashboard-status').textContent = document.querySelector('#pending-visits').hidden ? '' : saveMessage;
  } catch (error) { status.textContent = error.message; }
});

cancel.addEventListener('click', () => {
  resetForm();
  status.textContent = '';
  form.elements.date.focus();
});

form.elements.visitType.addEventListener('change', () => {
  if (form.elements.visitType.value === 'CSL donation') {
    form.elements.arm.value = defaultArm();
    status.textContent = 'CSL donation selected. Enter the screening values for this visit.';
    return;
  }
  for (const name of ['time', 'systolic', 'diastolic', 'pulse', 'weight', 'temperature', 'hematocrit', 'protein', 'duration', 'arm', 'notes']) {
    form.elements[name].value = '';
  }
  const preview = document.querySelector('#scan-preview');
  if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  preview.removeAttribute('src');
  preview.hidden = true;
  document.querySelector('#scan-status').textContent = '';
  document.querySelector('#scan-image').value = '';
  status.textContent = 'Non-CSL visit selected. Other fields were cleared; the date was kept.';
});

document.querySelector('#add-new-visit').addEventListener('click', () => {
  creatingNew = true;
  resetForm();
  document.querySelector('#pending-visits').hidden = true;
  document.querySelector('#entry-editor').hidden = false;
  form.elements.date.focus();
});

function download(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvValue(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"','""') + '"';
}

document.querySelector('#csv').onclick = () => {
  const rows = [...records].sort((a,b) => visitKey(a).localeCompare(visitKey(b)));
  const headers={date:'Date',time:'Time',visitType:'Visit type',systolic:'Systolic BP',diastolic:'Diastolic BP',pulse:'Pulse (bpm)',weight:'Weight (lb)',temperature:'Temperature (°F)',hematocrit:'Hematocrit',protein:'Total protein (g/dL)',duration:'Duration (min)',arm:'Arm',notes:'Notes',source:'Source'};
  const lines = [columns.map(key=>csvValue(headers[key]||key)).join(','), ...rows.map(row => columns.map(key => csvValue(row[key])).join(','))];
  download('donation-visits.csv', lines.join('\r\n') + '\r\n', 'text/csv');
};

document.querySelector('#backup').onclick = () => {
  download('donation-backup.json', JSON.stringify({version:1, records, medications:medicationEvents}, null, 2), 'application/json');
};

const fileInput = document.querySelector('#file');
document.querySelector('#import').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  try {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 5000000) throw new Error('Select a backup smaller than 5 MB.');
    const backup = JSON.parse(await file.text());
    if (backup?.version !== 1 || !Array.isArray(backup.records)) throw new Error('Choose a Donation Log JSON backup.');
    const next = new Map(records.map(row => [visitKey(row), row]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let conflicts = 0;
    const migratedLegacyKeys = new Set();
    for (const raw of backup.records) {
      const row = normalize(raw);
      const key = visitKey(row);
      let existing = next.get(key);
      const legacyKey = row.date + ' ' + row.time;
      if (!existing && !migratedLegacyKeys.has(legacyKey)) {
        const legacy = next.get(legacyKey);
        if (legacy && (legacy.source === 'Manual entry' || legacy.id === legacyKey)) {
          existing = legacy;
          next.delete(legacyKey);
          migratedLegacyKeys.add(legacyKey);
        }
      }
      if (existing) {
        if (columns.every(field => (existing[field] ?? '') === (row[field] ?? ''))) {
          unchanged++;
        } else if (existing.source === 'Manual entry' || existing.source === row.source || existing.id === legacyKey) {
          next.set(key, row);
          updated++;
        } else {
          conflicts++;
        }
      } else {
        next.set(key, row);
        added++;
      }
    }
    let medicationsAdded = 0;
    if (Array.isArray(backup.medications)) {
      const mergedMedications = new Map(medicationEvents.map(event => [event.date + '|' + event.label, event]));
      for (const event of backup.medications) {
        if (!event || !validDate(event.date) || typeof event.label !== 'string' || !event.label.trim() || event.label.length > 500) {
          throw new Error('A medication change in this backup has an invalid date or label.');
        }
        const normalizedEvent = {date:event.date, label:event.label.trim()};
        const key = normalizedEvent.date + '|' + normalizedEvent.label;
        if (!mergedMedications.has(key)) medicationsAdded++;
        mergedMedications.set(key, normalizedEvent);
      }
      medicationEvents = [...mergedMedications.values()].sort((a,b)=>a.date.localeCompare(b.date));
      await apiRequest('/medications', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({events:medicationEvents})});
      drawReport();
    }
    await save([...next.values()]);
    historyStatus.textContent = 'Import complete: ' + added + ' new, ' + updated + ' updated, ' + unchanged + ' unchanged, ' + conflicts + ' conflicts skipped' +
      (Array.isArray(backup.medications) ? ', ' + medicationsAdded + ' new medication changes' : '') + '.';
  } catch (error) { historyStatus.textContent = error instanceof SyntaxError ? 'The backup is not valid JSON.' : error.message; }
  finally { fileInput.value = ''; }
};

async function refreshVisits(showHistoryStatus=true) {
  visitsLoadState='loading';
  visitsLoadError='';
  if(showHistoryStatus) historyStatus.textContent='Refreshing visits…';
  drawReport();
  try {
    const response=await apiRequest('/visits');
    const data=await response.json();
    await loadSharedRecords(data);
    visitsLoadState='loaded';
    visitsLoadError='';
    document.querySelector('#connection-help').hidden=true;
    if(showHistoryStatus) historyStatus.textContent='History refreshed: '+records.length+' visits loaded.';
  } catch(error) {
    visitsLoadState='error';
    visitsLoadError=error.message;
    historyStatus.textContent=error.message;
    document.querySelector('#connection-help').hidden=false;
  }
  drawReport();
}
resetForm();
render();
document.querySelectorAll('.connect-google').forEach(button => button.addEventListener('click', startDonationSignIn));
(async function initializeDonationLog() {
  try {
    await restoreDonationSignIn();
  } catch (error) {
    setConnectionStatus(error.message);
  }
  if (!savedSession()) {
    visitsLoadState='error';
    visitsLoadError='Sign in to Donation Log to load your private visits.';
    historyStatus.textContent=visitsLoadError;
    document.querySelector('#connection-help').hidden=false;
    drawReport();
    return;
  }
  historyStatus.textContent='Loading your private visits…';
  await refreshVisits(false);
  apiRequest('/medications').then(async response=>{
    const data=await response.json();
    medicationEvents=Array.isArray(data.events)?data.events:[];
    drawReport();
  }).catch(()=>{medicationEvents=[];drawReport();});
})();
document.querySelector('#refresh-app').addEventListener('click', () => {
  const target = new URL(window.location.href);
  target.searchParams.set('refresh', String(Date.now()));
  target.hash = '';
  window.location.replace(target.href);
});

function drawReport() {
  const medications = document.querySelector('#medications');
  medications.replaceChildren();
  for (const event of medicationEvents) {
    const item = document.createElement('div');
    item.className = 'medication';
    item.textContent = new Date(event.date + 'T12:00:00').toLocaleDateString() + ' · ' + event.label;
    medications.append(item);
  }
  const allReadings = records.filter(row => row.systolic !== null && row.diastolic !== null).sort((a,b)=>a.date.localeCompare(b.date));
  const rangeCutoff = bpChartRange === 'all' ? '' : new Date(Date.now() - ({'3y':1095,'1y':365,'6m':183}[bpChartRange] || 0) * 86400000).toISOString().slice(0,10);
  const readings = rangeCutoff ? allReadings.filter(row => row.date >= rangeCutoff) : allReadings;
  const rangeCount=document.querySelector('#bp-chart-count');if(rangeCount)rangeCount.textContent=readings.length+' of '+allReadings.length+' readings';
  const svg = document.querySelector('#bp-chart');
  svg.replaceChildren();
  svg.setAttribute('viewBox','0 0 760 300');
  const reportStatus=document.querySelector('#report-load-status');
  const reportConnection=document.querySelector('#report-connection');
  if(reportStatus) {
    reportStatus.textContent=visitsLoadState==='loading' ? 'Loading saved visits…' :
      visitsLoadState==='error' ? 'Could not load saved visits: '+visitsLoadError :
      'Loaded '+records.length+' visits; '+readings.length+' have complete blood pressure readings.';
  }
  if(reportConnection) reportConnection.hidden=visitsLoadState!=='error';
  if (!readings.length) {
    const summary=document.querySelector('#period-summary');
    summary.textContent=visitsLoadState==='loading' ? 'Loading blood pressure readings…' :
      visitsLoadState==='error' ? 'The trend will appear after the saved visits load.' :
      records.length ? 'No complete blood pressure readings were found in the '+records.length+' saved visits. Check Visit history to confirm systolic and diastolic values are present.' :
      'No saved visits yet. Add blood pressure readings to see the trend.';
    return;
  }
  const ns='http://www.w3.org/2000/svg';
  const x=i=>62+(readings.length===1?0:i*640/(readings.length-1));
  const y=v=>250-(v-60)*2.1;
  for (const tick of [60,80,100,120,140,160,180]) {
    const line=document.createElementNS(ns,'line'); line.setAttribute('x1',55);line.setAttribute('x2',720);line.setAttribute('y1',y(tick));line.setAttribute('y2',y(tick));line.setAttribute('stroke','#d8e2df');svg.append(line);
    const label=document.createElementNS(ns,'text');label.setAttribute('x',8);label.setAttribute('y',y(tick)+4);label.setAttribute('font-size','12');label.textContent=String(tick);svg.append(label);
  }
  const addSeries=(field,color,title)=>{
    const points=readings.map((row,i)=>x(i)+','+y(row[field])).join(' ');
    const poly=document.createElementNS(ns,'polyline');poly.setAttribute('points',points);poly.setAttribute('fill','none');poly.setAttribute('stroke',color);poly.setAttribute('stroke-width','2.5');svg.append(poly);
    readings.forEach((row,i)=>{const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',x(i));dot.setAttribute('cy',y(row[field]));dot.setAttribute('r','3.5');dot.setAttribute('fill',color);dot.setAttribute('aria-label',row.date+' '+title+' '+row[field]);svg.append(dot);});
  };
  addSeries('systolic','#b4422e','Systolic');addSeries('diastolic','#236a83','Diastolic');
  for (const event of medicationEvents) {
    const index=readings.findIndex(row=>row.date>=event.date);
    if(index<0) continue;
    const line=document.createElementNS(ns,'line');line.setAttribute('x1',x(index));line.setAttribute('x2',x(index));line.setAttribute('y1',15);line.setAttribute('y2',250);line.setAttribute('stroke','#7d5b9b');line.setAttribute('stroke-dasharray','5 4');svg.append(line);
  }
  const legend=document.createElementNS(ns,'text');legend.setAttribute('x',565);legend.setAttribute('y',20);legend.setAttribute('font-size','13');legend.textContent='● Systolic   ● Diastolic   ⋮ Medication';svg.append(legend);
  const periods=[['Before Feb 25, 2026',r=>r.date<'2026-02-25'],['Feb 25–May 31, 2026',r=>r.date>='2026-02-25'&&r.date<'2026-06-01'],['Jun 1, 2026 onward',r=>r.date>='2026-06-01']];
  const summary=document.querySelector('#period-summary');summary.replaceChildren();
  for(const [name,include] of periods){const subset=readings.filter(include);const box=document.createElement('div');if(subset.length){const mean=key=>Math.round(subset.reduce((total,row)=>total+row[key],0)/subset.length);box.textContent=name+' · '+subset.length+' readings · average '+mean('systolic')+'/'+mean('diastolic')+' mm Hg';}else box.textContent=name+' · no readings';summary.append(box);}
}
drawReport();
function wrapCanvasText(ctx,text,x,y,maxWidth,lineHeight){
  let line='';
  for(const word of String(text).split(/\\s+/)){const candidate=line?line+' '+word:word;if(ctx.measureText(candidate).width>maxWidth&&line){ctx.fillText(line,x,y);line=word;y+=lineHeight;}else line=candidate;}
  if(line)ctx.fillText(line,x,y);
  return y+lineHeight;
}
async function createReportPdf(){
  const canvas=document.createElement('canvas');canvas.width=1240;canvas.height=1754;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#142d33';ctx.font='bold 48px system-ui,sans-serif';ctx.fillText('Blood pressure report',72,92);
  ctx.fillStyle='#526567';ctx.font='25px system-ui,sans-serif';ctx.fillText('CSL donation screening readings · mm Hg',72,140);
  let y=205;
  const medText=[...document.querySelectorAll('#medications .medication')].map(node=>node.textContent.trim());
  ctx.font='23px system-ui,sans-serif';ctx.fillStyle='#17252b';
  for(const item of medText){ctx.fillStyle='#fff5f1';ctx.fillRect(72,y-32,1096,78);ctx.fillStyle='#17252b';y=wrapCanvasText(ctx,item,92,y,1045,31)+12;}
  const status=document.querySelector('#report-load-status')?.textContent?.trim();ctx.fillStyle='#526567';ctx.font='21px system-ui,sans-serif';y=wrapCanvasText(ctx,status||'',72,y+10,1096,29);
  ctx.fillStyle='#17252b';ctx.font='bold 25px system-ui,sans-serif';ctx.fillText('Blood pressure trend',72,y+36);
  const svg=document.querySelector('#bp-chart');const markup=new XMLSerializer().serializeToString(svg);const url=URL.createObjectURL(new Blob([markup],{type:'image/svg+xml;charset=utf-8'}));
  try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});ctx.drawImage(image,72,y+55,1096,432);}finally{URL.revokeObjectURL(url);}
  y+=530;
  ctx.fillStyle='#526567';ctx.font='22px system-ui,sans-serif';
  for(const item of [...document.querySelectorAll('#period-summary>*')]){y=wrapCanvasText(ctx,item.textContent,72,y,1096,31)+14;}
  ctx.font='18px system-ui,sans-serif';ctx.fillStyle='#667';ctx.fillText('Prepared '+new Date().toLocaleDateString(),72,1688);
  const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));if(!jpeg)throw new Error('PDF image creation failed');
  const jpg=new Uint8Array(await jpeg.arrayBuffer());const enc=new TextEncoder();const parts=[];let size=0;const offsets=[0];
  const push=chunk=>{const bytes=typeof chunk==='string'?enc.encode(chunk):chunk;parts.push(bytes);size+=bytes.length;};
  push('%PDF-1.4\\n%âãÏÓ\\n');
  const objects=[
    '1 0 obj\\n<< /Type /Catalog /Pages 2 0 R >>\\nendobj\\n',
    '2 0 obj\\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\\nendobj\\n',
    '3 0 obj\\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\\nendobj\\n',
    null,
    '5 0 obj\\n<< /Length 36 >>\\nstream\\nq 595 0 0 842 0 0 cm /Im0 Do Q\\nendstream\\nendobj\\n'
  ];
  for(let i=0;i<objects.length;i++){offsets.push(size);if(i===3){push('4 0 obj\\n<< /Type /XObject /Subtype /Image /Width '+canvas.width+' /Height '+canvas.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+jpg.length+' >>\\nstream\\n');push(jpg);push('\\nendstream\\nendobj\\n');}else push(objects[i]);}
  const xref=size;push('xref\\n0 6\\n0000000000 65535 f \\n');for(let i=1;i<=5;i++)push(String(offsets[i]).padStart(10,'0')+' 00000 n \\n');push('trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n'+xref+'\\n%%EOF');
  return new Blob(parts,{type:'application/pdf'});
}
document.querySelector('#print-report').addEventListener('click',async()=>{
  const status=document.querySelector('#export-status');const button=document.querySelector('#print-report');button.disabled=true;status.textContent='Preparing your report PDF…';
  try{const pdf=await createReportPdf();const file=new File([pdf],'blood-pressure-report.pdf',{type:'application/pdf'});if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Blood pressure report'});status.textContent='Use the share menu to save the PDF to Files or choose Print.';}else{const url=URL.createObjectURL(pdf);const link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status.textContent='Report PDF downloaded. Open it to save or print.';}}catch(error){if(error.name!=='AbortError')status.textContent='Could not create the report PDF. Please try again.';}finally{button.disabled=false;}
});
document.querySelector('#save-chart-image').addEventListener('click',async()=>{
  const status=document.querySelector('#export-status');
  const svg=document.querySelector('#bp-chart');
  if(!svg.querySelector('polyline')){status.textContent='Load blood pressure readings and show the graph before saving an image.';return;}
  try{
    const markup=new XMLSerializer().serializeToString(svg);
    const source=new Blob([markup],{type:'image/svg+xml;charset=utf-8'});
    const url=URL.createObjectURL(source);
    const image=new Image();
    image.onload=async()=>{
      try{
        const canvas=document.createElement('canvas');canvas.width=1520;canvas.height=720;
        const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
        const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        if(!png)throw new Error('Image export failed');
        const file=new File([png],'blood-pressure-trend.png',{type:'image/png'});
        if(navigator.canShare?.({files:[file]})&&navigator.share){await navigator.share({files:[file],title:'Blood pressure trend'});status.textContent='Choose Save Image in the share sheet to add the chart to Photos.';}
        else{const link=document.createElement('a');link.href=URL.createObjectURL(png);link.download=file.name;link.click();status.textContent='Chart image downloaded. Open it and use Share → Save Image to add it to Photos.';}
      }catch(error){if(error.name!=='AbortError')status.textContent='Could not create the chart image. Try Print / Save report as PDF instead.';}
      finally{URL.revokeObjectURL(url);}
    };
    image.onerror=()=>{URL.revokeObjectURL(url);status.textContent='Could not create the chart image. Try Print / Save report as PDF instead.';};
    image.src=url;
  }catch{status.textContent='Could not create the chart image. Try Print / Save report as PDF instead.';}
});
const menu=document.querySelector('#app-menu');
const menuButton=document.querySelector('#menu-open');
function closeMenu(){if(menu.open)menu.close();menuButton.setAttribute('aria-expanded','false');}
menuButton.addEventListener('click',()=>{if(!menu.open)menu.showModal();menuButton.setAttribute('aria-expanded','true');document.querySelector('#menu-close').focus();});
document.querySelector('#menu-close').addEventListener('click',()=>{closeMenu();menuButton.focus();});
menu.addEventListener('close',()=>menuButton.setAttribute('aria-expanded','false'));
menu.addEventListener('cancel',()=>menuButton.setAttribute('aria-expanded','false'));
menu.addEventListener('click',event=>{if(event.target===menu)closeMenu();});
document.querySelectorAll('.menu-link[data-trend]').forEach(link=>link.addEventListener('click',()=>{
  activeTrend=link.dataset.trend;
  document.querySelectorAll('[data-page-panel]').forEach(panel=>panel.hidden=panel.dataset.pagePanel!=='trend');
  document.querySelectorAll('.menu-link').forEach(item=>item.classList.toggle('active',item===link));
  document.querySelector('.menu-trends').open=false;
  closeMenu();
  drawMetricTrend();
}));
document.querySelector('#trend-range').addEventListener('change',drawMetricTrend);
document.querySelector('#bp-chart-range').addEventListener('change',event=>{bpChartRange=event.target.value;drawReport();});
document.querySelectorAll('.menu-link[data-page]').forEach(link=>link.addEventListener('click',()=>{
  const selected=link.dataset.page;
  document.querySelectorAll('[data-page-panel]').forEach(panel=>panel.hidden=panel.dataset.pagePanel!==selected);
  document.querySelectorAll('.menu-link').forEach(item=>item.classList.toggle('active',item===link));
  closeMenu();
}));
const chartToggle=document.querySelector('#toggle-bp-chart');
chartToggle.addEventListener('click',()=>{
  const panel=document.querySelector('#bp-chart-panel');
  panel.hidden=!panel.hidden;
  chartToggle.setAttribute('aria-expanded',String(!panel.hidden));
  chartToggle.textContent=panel.hidden?'Show BP graph':'Hide BP graph';
});

const scanImage=document.querySelector('#scan-image');
scanImage.addEventListener('change',async()=>{
  const file=scanImage.files?.[0]; if(!file)return;
  const preview=document.querySelector('#scan-preview');
  if(preview.src.startsWith('blob:'))URL.revokeObjectURL(preview.src);
  preview.src=URL.createObjectURL(file);preview.hidden=false;
  const message=document.querySelector('#scan-status');
  message.textContent='Screenshot opened for review. Fill the visit fields from the image, then save the visit.';
  const Detector=window.TextDetector;
  if(Detector){
    try{
      const detector=new Detector();const text=await detector.detect(preview);
      const combined=text.map(part=>part.rawValue).join(' ');
      const bp=combined.match(/(\d{2,3})\s*[\/]\s*(\d{2,3})/);
      const date=combined.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
      const weight=combined.match(/(\d{2,3})\s*lbs?/i);
      const pulse=combined.match(/(\d{2,3})\s*beats?\s*\/\s*min/i);
      const temperature=combined.match(/(\d{2,3}(?:\.\d)?)\s*°?\s*F\b/i);
      const time=combined.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
      if(bp){form.elements.systolic.value=bp[1];form.elements.diastolic.value=bp[2];}
      if(weight)form.elements.weight.value=weight[1];
      if(pulse)form.elements.pulse.value=pulse[1];
      if(temperature)form.elements.temperature.value=temperature[1];
      if(time){let hour=Number(time[1])%12;if(time[3].toUpperCase()==='PM')hour+=12;form.elements.time.value=String(hour).padStart(2,'0')+':'+time[2];}
      if(date){const parsed=new Date(date[0]);if(!Number.isNaN(parsed.valueOf()))form.elements.date.value=parsed.toISOString().slice(0,10);}
      message.textContent=bp?'Possible readings filled in. Check every field against the screenshot before saving.':'Screenshot opened. Check the date and readings in the image and enter them in the form.';
    }catch{message.textContent='Screenshot opened. Check the date and readings in the image and enter them in the form.';}
  }
  scanImage.value='';
});

