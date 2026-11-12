'use strict';

const storageKey = 'csl-donation-visits-v1';
const apiBase = 'https://donation-log-api.onlinesny.workers.dev/api';
const workoutSessionKey = 'daily-workout-google-session-v1';
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

function savedSession() {
  try {
    const value = JSON.parse(localStorage.getItem(workoutSessionKey) || 'null');
    return value?.expires * 1000 > Date.now() && typeof value.session === 'string' ? value : null;
  } catch { return null; }
}

async function apiRequest(path, options = {}) {
  const session = savedSession();
  if (!session) throw new Error('Connect Google in Daily Workout, then return here and refresh.');
  const response = await fetch(apiBase + path, {
    ...options,
    cache: 'no-store',
    headers: { ...(options.headers || {}), Authorization: 'Bearer ' + session.session }
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || (response.status === 401 ? 'Your Google connection needs renewal. Reconnect in Daily Workout.' : 'The shared database is unavailable.'));
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
historyStatus.textContent='Loading your shared visits…';
refreshVisits(false);
apiRequest('/medications').then(async response=>{
  const data=await response.json();
  medicationEvents=Array.isArray(data.events)?data.events:[];
  drawReport();
}).catch(()=>{medicationEvents=[];drawReport();});
document.querySelector('#visit-refresh').addEventListener('click',()=>refreshVisits(true));
document.querySelector('#refresh-report').addEventListener('click',()=>refreshVisits(false));
function drawReport() {
  const medications = document.querySelector('#medications');
  medications.replaceChildren();
  for (const event of medicationEvents) {
    const item = document.createElement('div');
    item.className = 'medication';
    item.textContent = new Date(event.date + 'T12:00:00').toLocaleDateString() + ' · ' + event.label;
    medications.append(item);
  }
  const readings = records.filter(row => row.systolic !== null && row.diastolic !== null).sort((a,b)=>a.date.localeCompare(b.date));
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
document.querySelector('#print-report').addEventListener('click',()=>window.print());
const menu=document.querySelector('#app-menu');
const menuButton=document.querySelector('#menu-open');
const backdrop=document.querySelector('#menu-backdrop');
function closeMenu(){menu.classList.remove('open');menu.setAttribute('aria-hidden','true');menuButton.setAttribute('aria-expanded','false');backdrop.hidden=true;}
menuButton.addEventListener('click',()=>{menu.classList.add('open');menu.setAttribute('aria-hidden','false');menuButton.setAttribute('aria-expanded','true');backdrop.hidden=false;document.querySelector('#menu-close').focus();});
document.querySelector('#menu-close').addEventListener('click',()=>{closeMenu();menuButton.focus();});
backdrop.addEventListener('click',closeMenu);
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
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

