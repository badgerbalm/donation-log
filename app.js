'use strict';

const storageKey = 'csl-donation-visits-v1';
try { localStorage.removeItem(storageKey); } catch {}
const apiBase = 'https://donation-log-api.onlinesny.workers.dev/api';
const donationSessionKey = 'donation-log-google-session-v1';
const pendingAuthKey = 'donation-log-google-pending-v1';
const cslDraftKey = 'donation-log-csl-progress-draft-v1';
const authBase = 'https://daily-workout-auth.onlinesny.workers.dev';
const fields = ['systolic', 'diastolic', 'pulse', 'weight', 'temperature', 'hematocrit', 'protein', 'duration'];
const columns = ['date', 'time', 'visitType', ...fields, 'finger', 'arm', 'notes', 'source'];
const form = document.querySelector('#visit');
const status = document.querySelector('#status');
const historyStatus = document.querySelector('#history-status');
const history = document.querySelector('#history');
const cancel = document.querySelector('#cancel');
const heading = document.querySelector('#form-title');
let editing = null;
let creatingNew = false;
let entryPhase = 'intake';
let qrPreviewUrl = '';
let activeVisitId = null;
let activeCslDraft = null;
let scanWasRead = false;
let records = [];
let canWrite = true;
let medicationEvents = [];
let visitsLoadState = 'loading';
let visitsLoadError = '';
let activeTrend = 'bp';
window.addEventListener('donation-log:trend-selected',event=>{activeTrend=event.detail?.trend||'bp';drawMetricTrend();});
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
  const row = { id: input.id || (input.date + ' ' + (input.time || '')), date: input.date, time: input.time || '', visitType: input.visitType || defaultVisitType, finger: input.finger || '', arm: input.arm || '', notes: input.notes || '', source: input.source || 'Manual entry' };
  const validFingers = ['', 'Left thumb', 'Left index', 'Left middle', 'Left ring', 'Left little', 'Right thumb', 'Right index', 'Right middle', 'Right ring', 'Right little'];
  if (!['CSL donation', 'Doctor / clinic', 'Home reading', 'Other BP reading', 'Other'].includes(row.visitType) || !validFingers.includes(row.finger) || !['', 'Left', 'Right', 'Both'].includes(row.arm) || typeof row.notes !== 'string' || row.notes.length > 2000) {
    throw new Error('Check the screening finger, donation arm, and visit notes.');
  }
  for (const field of fields) {
    const value = input[field];
    const number = value === '' || value == null ? null : Number(value);
    const whole = ['systolic', 'diastolic', 'pulse', 'duration'].includes(field);
    if (number !== null && (!['string','number'].includes(typeof value) || !Number.isFinite(number) ||
      number < 0 || (whole && (!Number.isInteger(number) || number < 1 || number > (field === 'duration' ? 180 : 400))) ||
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
const resumableCslPhases = new Set(['details','duration','scan']);
function saveLocalCslDraft(phase=entryPhase){
  if(!creatingNew||form.elements.visitType.value!=='CSL donation'||!resumableCslPhases.has(phase))return false;
  const values=Object.fromEntries(new FormData(form));
  const draft={...values,id:activeVisitId||values.id||makeVisitId(),visitType:'CSL donation',phase,savedOn:localToday(),savedAt:Date.now(),scanWasRead};
  try{
    localStorage.setItem(cslDraftKey,JSON.stringify(draft));
    activeCslDraft=draft;
    return true;
  }catch(error){return false;}
}
function clearLocalCslDraft(){
  try{localStorage.removeItem(cslDraftKey);activeCslDraft=null;return true;}
  catch(error){return false;}
}
function autoSaveCslDraft(){
  if(!creatingNew||form.elements.visitType.value!=='CSL donation'||!resumableCslPhases.has(entryPhase))return;
  status.textContent=saveLocalCslDraft(entryPhase)
    ? 'In-progress CSL details saved on this device.'
    : 'Could not save the in-progress visit on this device. Keep Donation Log open and retry.';
}
async function restoreCslDraft(){
  let draft;
  try{draft=JSON.parse(localStorage.getItem(cslDraftKey)||'null');}
  catch(error){return false;}
  if(!draft)return false;
  if(draft.savedOn!==localToday()||!resumableCslPhases.has(draft.phase)||!draft.id){
    clearLocalCslDraft();
    return false;
  }
  activeCslDraft=draft;
  activeVisitId=draft.id;
  const existing=records.find(row=>row.id===draft.id);
  editing=existing?visitKey(existing):null;
  creatingNew=true;
  scanWasRead=Boolean(draft.scanWasRead);
  for(const name of ['id','date','visitType',...fields,'finger','arm','notes']){
    if(form.elements[name])form.elements[name].value=draft[name]??'';
  }
  form.elements.id.value=draft.id;
  form.elements.visitType.value='CSL donation';
  entryPhase=draft.phase;
  heading.textContent='New Visit';
  cancel.hidden=false;
  renderWorkflow();
  renderEntryDashboard();
  status.textContent=draft.phase==='scan'
    ? 'Your in-progress visit was restored from this device. Re-select the CSL screenshot if needed.'
    : 'Your in-progress visit was restored from this device.';
  return true;
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
  const cleaned=[...loaded];
  const duplicateIdsToDelete=[];
  let mergedDuplicates=0;
  let retainedConflicts=0;
  for(const manual of loaded.filter(row=>row.source==='Manual entry'&&row.id===dateTimeKey(row))){
    if(!cleaned.includes(manual))continue;
    const index=cleaned.findIndex(row=>row!==manual&&row.source!=='Manual entry'&&row.visitType===manual.visitType&&dateTimeKey(row)===dateTimeKey(manual));
    if(index<0)continue;
    const imported=cleaned[index];
    const mergeFields=[...fields,'finger','arm'];
    const hasValue=value=>value!==null&&value!==undefined&&value!=='';
    const conflicts=mergeFields.some(field=>hasValue(imported[field])&&hasValue(manual[field])&&String(imported[field])!==String(manual[field]))||Boolean(imported.notes&&manual.notes&&imported.notes!==manual.notes&&(imported.notes+' | '+manual.notes).length>2000);
    if(conflicts){retainedConflicts++;continue;}
    const merged={...imported};
    for(const field of mergeFields)if(!hasValue(merged[field])&&hasValue(manual[field]))merged[field]=manual[field];
    if(manual.notes&&manual.notes!==imported.notes)merged.notes=imported.notes?[imported.notes,manual.notes].filter(Boolean).join(' | '):manual.notes;
    cleaned[index]=merged;
    cleaned.splice(cleaned.indexOf(manual),1);
    duplicateIdsToDelete.push(visitKey(manual));
    mergedDuplicates++;
  }
  records=cleaned;
  if(activeCslDraft){
    const resumed=cleaned.find(row=>row.id===activeCslDraft.id);
    if(resumed)editing=visitKey(resumed);
  }
  render();drawReport();
  if(!editing&&!activeCslDraft) form.elements.arm.value=defaultArm();
  if(duplicateIdsToDelete.length||correctedLabels){
    await save(cleaned);
    for(const id of duplicateIdsToDelete)await apiRequest('/visits',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
    const messages=['Loaded '+cleaned.length+' visits'];
    if(correctedLabels)messages.push('corrected Hematocrit and Total protein labels on '+correctedLabels+' spreadsheet rows');
    if(mergedDuplicates)messages.push('merged '+mergedDuplicates+' duplicate legacy copies while preserving their entered details');
    if(retainedConflicts)messages.push('kept '+retainedConflicts+' same-date records separate because their values differ');
    historyStatus.textContent=messages.join('; ')+'.';
  }
}

function makeVisitId() {
  return 'donation-log-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
}
function activeRow() {
  return editing ? records.find(row => visitKey(row) === editing) : null;
}
function setPhase(phase) {
  entryPhase = phase;
  renderWorkflow();
}
function renderWorkflow() {
  const type = form.elements.visitType.value;
  const isCsl = type === 'CSL donation';
  const meta = document.querySelector('#visit-meta');
  const cslFields = document.querySelector('#csl-fields');
  const intake = document.querySelector('#csl-intake-stage');
  const qrCapture = document.querySelector('#qr-capture-stage');
  const duration = document.querySelector('#duration-stage');
  const scan = document.querySelector('#scan-stage');
  const review = document.querySelector('#scan-review-fields');
  const notes = document.querySelector('#visit-notes-wrap');
  const stepper = document.querySelector('#workflow-stepper');
  const context = document.querySelector('#visit-context');
  const back = document.querySelector('#phase-back');
  const saveButton = document.querySelector('#phase-save');
  const description = document.querySelector('#phase-description');
  const visitTypeField = document.querySelector('#visit-type-field');
  const row = activeRow();
  const phase = isCsl ? entryPhase : 'other';
  visitTypeField.hidden = isCsl && phase !== 'intake';
  form.classList.toggle('before-donation-layout', isCsl && phase === 'details');
  const preCheckin = ['intake', 'qrCapture', 'qrShow'].includes(phase);
  const checkinLabels = ['Start CSL Intake', 'Capture QR', 'Show QR at desk'];
  const donationLabels = ['Before Donation', 'Duration', 'Scan Summary'];
  const labels = preCheckin ? checkinLabels : donationLabels;
  stepper.hidden = !isCsl;
  stepper.dataset.flow = preCheckin ? 'checkin' : 'donation';
  for (const li of stepper.querySelectorAll('[data-step]')) {
    const num = Number(li.dataset.step);
    li.querySelector('b').textContent = labels[num - 1];
    const currentStep = preCheckin ? (phase === 'intake' ? 1 : phase === 'qrCapture' ? 2 : 3) : (phase === 'details' ? 1 : phase === 'duration' ? 2 : 3);
    const completedThrough = preCheckin ? currentStep - 1 : (phase === 'duration' ? 1 : phase === 'scan' ? 2 : 0);
    li.classList.toggle('current', isCsl && num === currentStep);
    li.classList.toggle('complete', isCsl && num <= completedThrough);
  }
  meta.hidden = isCsl && !['intake', 'details'].includes(phase);
  intake.hidden = !isCsl || phase !== 'intake';
  qrCapture.hidden = !isCsl || phase !== 'qrCapture';
  cslFields.hidden = !isCsl || phase !== 'details';
  duration.hidden = !isCsl || phase !== 'duration';
  scan.hidden = isCsl ? phase !== 'scan' : false;
  review.hidden = isCsl ? phase !== 'scan' : !scanWasRead;
  notes.hidden = isCsl;
  context.hidden = !isCsl || ['intake', 'qrCapture', 'qrShow', 'details'].includes(phase);
  if (context.hidden) context.textContent = '';
  else {
    const pieces = [];
    if (row?.hematocrit !== null && row?.hematocrit !== undefined) pieces.push('Hematocrit ' + row.hematocrit + '%');
    if (row?.protein !== null && row?.protein !== undefined) pieces.push('Protein ' + row.protein.toFixed(1) + ' g/dL');
    if (phase === 'scan' && row?.duration !== null && row?.duration !== undefined) pieces.push('Duration ' + row.duration + ' min');
    context.textContent = pieces.join(' · ');
  }
  back.hidden = !isCsl || phase === 'intake' || phase === 'details';
  back.textContent = phase === 'duration' ? 'Back to screening' : phase === 'scan' ? 'Back to duration' : 'Back';
  saveButton.hidden = isCsl && preCheckin;
  saveButton.textContent = isCsl
    ? (phase === 'details' ? 'Save Visit Details' : phase === 'duration' ? 'Save Duration' : 'Save Visit')
    : 'Save Visit';
  if (!isCsl) {
    heading.textContent = type === 'Doctor / clinic' ? 'Doctor Visit' : 'Other Visit';
    document.querySelector('#scan-stage-title').textContent = 'Scan Visit Summary';
    document.querySelector('#scan-help').textContent = 'Choose a Doctor or Other after-visit summary screenshot to read its details.';
    description.textContent = scanWasRead ? 'Review the extracted values, add notes if helpful, then save.' : 'Choose a visit summary screenshot to read its details. You can also enter readings after scanning.';
  } else {
    document.querySelector('#scan-stage-title').textContent = 'Scan CSL Confirmation';
    document.querySelector('#scan-help').textContent = 'Choose a CSL Donation Details screenshot to add the remaining readings.';
    if (phase === 'intake') {
      heading.textContent = 'CSL Check-in';
      description.textContent = 'Open CSL intake, complete the questions, then return here with your QR screenshot.';
    } else if (phase === 'qrCapture') {
      heading.textContent = 'Capture your QR';
      description.textContent = 'Select the QR screenshot CSL created for this check-in.';
    } else if (phase === 'qrShow') {
      heading.textContent = 'Show QR at the desk';
      description.textContent = 'Keep this QR visible while CSL scans it at the front desk.';
    } else if (phase === 'details') {
      heading.textContent = 'Before Donation';
      description.textContent = 'Enter the finger used for screening and the arm planned for donation. Progress saves on this device as you go.';
    } else if (phase === 'duration') {
      heading.textContent = 'Donation Duration';
      description.textContent = 'After your donation, enter how long it took. Progress saves on this device as you go.';
    } else {
      heading.textContent = 'Scan Visit Summary';
      description.textContent = 'Choose the CSL Donation Details screenshot. Review all values before saving.';
    }
  }
  const priorCard = document.querySelector('#prior-visit-card');
  const showPrior = isCsl && ['details','duration'].includes(phase);
  priorCard.hidden = !showPrior;
  if (showPrior) renderPriorVisitSummary();
  const deskQr = document.querySelector('#qr-display');
  if (qrPreviewUrl) { deskQr.src = qrPreviewUrl; deskQr.hidden = false; }
  else { deskQr.removeAttribute('src'); deskQr.hidden = true; }

  if (isCsl && phase === 'duration') {
    document.querySelector('#screening-summary').textContent = [
      row?.date ? new Date(row.date + 'T12:00:00').toLocaleDateString() : '',
      row?.finger ? 'Finger stick ' + row.finger : '',
      row?.arm ? 'Donation arm ' + row.arm : '',
      row?.hematocrit !== null && row?.hematocrit !== undefined ? 'Hematocrit ' + row.hematocrit + '%' : '',
      row?.protein !== null && row?.protein !== undefined ? 'Protein ' + row.protein.toFixed(1) + ' g/dL' : ''
    ].filter(Boolean).join(' · ');
  }
}
function renderLastVisitSummary() {
  const row = [...records].filter(item => item.visitType === 'CSL donation').sort((a,b) => dateTimeKey(b).localeCompare(dateTimeKey(a)))[0];
  const card = document.querySelector('#last-visit-card');
  const date = document.querySelector('#last-visit-date');
  const details = document.querySelector('#last-visit-details');
  if (!row) {
    if (visitsLoadState === 'loading') {
      date.textContent = 'Loading visit history…';
      details.textContent = 'Your latest CSL summary will appear here once your private data loads.';
    } else if (visitsLoadState === 'error') {
      date.textContent = 'Sign in to view your last visit';
      details.textContent = 'Your private visit history has not loaded in this browser yet.';
    } else {
      date.textContent = 'No CSL visits saved yet';
      details.textContent = 'Your latest visit summary will appear here.';
    }
    return;
  }
  date.textContent = new Date(row.date + 'T12:00:00').toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'});
  details.textContent = [
    row.finger ? 'Finger stick ' + row.finger : '',
    row.arm ? 'Donation arm ' + row.arm : '',
    row.hematocrit !== null ? 'Hematocrit ' + row.hematocrit + '%' : '',
    row.protein !== null ? 'Protein ' + row.protein.toFixed(1) + ' g/dL' : '',
    row.duration !== null ? 'Duration ' + row.duration + ' min' : ''
  ].filter(Boolean).join('  ·  ') || 'Visit details not entered yet';
}
function renderPriorVisitSummary() {
  const prior = [...records].filter(item => item.visitType === 'CSL donation' && String(item.id || '') !== String(activeVisitId || '') && visitKey(item) !== editing).sort((x,y) => dateTimeKey(y).localeCompare(dateTimeKey(x)))[0];
  const date = document.querySelector('#prior-visit-date');
  const details = document.querySelector('#prior-visit-details');
  if (!prior) { date.textContent = 'No previous CSL visit'; details.textContent = 'Your last donation summary will appear here.'; return; }
  date.textContent = new Date(prior.date + 'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
  details.textContent = [prior.finger ? 'Finger stick: ' + prior.finger : '', prior.arm ? 'Donation arm: ' + prior.arm : '', prior.hematocrit !== null ? 'Hematocrit: ' + prior.hematocrit + '%' : '', prior.protein !== null ? 'Protein: ' + prior.protein.toFixed(1) + ' g/dL' : '', prior.duration !== null ? 'Duration: ' + prior.duration + ' min' : ''].filter(Boolean).join(' · ');
}
function resetForm() {
  clearScanSelection();
  clearQrSelection();
  form.reset();
  editing = null;
  activeVisitId = null;
  creatingNew = false;
  scanWasRead = false;
  entryPhase = 'intake';
  heading.textContent = 'New Visit';
  cancel.hidden = true;
  form.elements.arm.value = defaultArm();
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  form.elements.date.value = now.toISOString().slice(0, 10);
  form.elements.visitType.value = 'CSL donation';
  form.elements.id.value = '';
  renderWorkflow();
  renderEntryDashboard();
}
function startEditing(row) {
  editing = visitKey(row);
  activeVisitId = row.id || editing;
  creatingNew = false;
  scanWasRead = Boolean(row.systolic !== null || row.diastolic !== null || row.pulse !== null || row.weight !== null || row.temperature !== null);
  for (const field of columns) if (form.elements[field]) form.elements[field].value = row[field] ?? '';
  form.elements.id.value = row.id || '';
  entryPhase = row.visitType === 'CSL donation' && row.id?.startsWith('donation-log-')
    ? (row.duration === null ? 'duration' : (row.time || row.systolic === null ? 'scan' : 'details'))
    : 'details';
  heading.textContent = needsDonationDetails(row) ? 'Continue CSL Visit' : 'Edit Visit';
  cancel.hidden = false;
  status.textContent = 'Continue this saved visit. Your changes update the same visit record.';
  document.querySelectorAll('[data-page-panel]').forEach(panel => panel.hidden = panel.dataset.pagePanel !== 'entry');
  document.querySelectorAll('.menu-link').forEach(link => link.classList.toggle('active', link.dataset.page === 'entry'));
  renderWorkflow();
  renderEntryDashboard();
}
function needsDonationDetails(row) {
  if (row.visitType !== 'CSL donation') return false;
  const legacyPreDonation = !row.id?.startsWith('donation-log-') && !row.time && row.arm && (row.hematocrit !== null || row.protein !== null) && row.systolic === null && row.diastolic === null && row.pulse === null && row.weight === null && row.temperature === null;
  return Boolean(legacyPreDonation || (row.id?.startsWith('donation-log-') && (row.duration === null || (row.time === '' && row.systolic === null && row.diastolic === null && row.pulse === null && row.weight === null && row.temperature === null))));
}
function createDonationDropIcon(className = 'pending-visit-icon') {
  const wrapper = document.createElement('span');
  wrapper.className = className;
  wrapper.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('focusable', 'false');
  const drop = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  drop.setAttribute('d', 'M32 4C25 15 12 28 12 40a20 20 0 0 0 40 0C52 28 39 15 32 4Z');
  drop.setAttribute('fill', '#ff3349');
  drop.setAttribute('stroke', '#fff');
  drop.setAttribute('stroke-width', '4');
  const shine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shine.setAttribute('d', 'M24 39c0 5 3 9 8 11');
  shine.setAttribute('fill', 'none');
  shine.setAttribute('stroke', '#fff');
  shine.setAttribute('stroke-width', '4');
  shine.setAttribute('stroke-linecap', 'round');
  svg.append(drop, shine);
  wrapper.append(svg);
  return wrapper;
}
function renderEntryDashboard() {
  const panel = document.querySelector('#pending-visits');
  if (!panel) return;
  const todaysVisits = records.filter(row => row.date === localToday()).sort((a,b) => dateTimeKey(b).localeCompare(dateTimeKey(a)));
  const showQrAtHome = creatingNew && entryPhase === 'qrShow';
  const showDashboard = editing === null && (!creatingNew || showQrAtHome);
  panel.hidden = !showDashboard;
  panel.classList.toggle('qr-only', showQrAtHome);
  document.querySelector('main').classList.toggle('qr-mode', showQrAtHome);
  document.querySelector('#last-visit-card').hidden = showQrAtHome;
  document.querySelector('#home-qr-card').hidden = !showQrAtHome;
  document.querySelector('#entry-editor').hidden = !editing && (!creatingNew || showQrAtHome);
  const list = document.querySelector('#pending-list');
  list.replaceChildren();
  document.querySelector('#today-empty-state').hidden = todaysVisits.length > 0;
  for (const row of todaysVisits) {
    const item = document.createElement('div');
    item.className = 'pending-visit' + (row.visitType === 'CSL donation' ? ' csl-visit' : '');
    if (row.visitType === 'CSL donation') item.append(createDonationDropIcon());
    const summary = document.createElement('p');
    const details = [row.time || (needsDonationDetails(row) ? 'In progress' : 'Time not entered'), row.visitType];
    if (row.finger) details.push('Finger stick ' + row.finger);
    if (row.arm) details.push('Donation arm ' + row.arm);
    if (row.hematocrit !== null) details.push('Hematocrit ' + row.hematocrit + '%');
    if (row.protein !== null) details.push('Protein ' + row.protein.toFixed(1) + ' g/dL');
    if (row.duration !== null) details.push(row.duration + ' min');
    if (row.systolic !== null && row.diastolic !== null) details.push('BP ' + row.systolic + '/' + row.diastolic);
    if (row.pulse !== null) details.push('Pulse ' + row.pulse);
    if (row.weight !== null) details.push('Weight ' + row.weight + ' lb');
    if (row.temperature !== null) details.push('Temp ' + row.temperature + ' °F');
    details.unshift(new Date(row.date + 'T12:00:00').toLocaleDateString());
    summary.textContent = details.join(' · ');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = needsDonationDetails(row) ? 'Continue Visit' : 'Edit Visit';
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
  renderLastVisitSummary();
  if (editing || creatingNew) renderWorkflow();
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
    const values=[row.date,row.visitType,(row.systolic??'')+'/'+(row.diastolic??''),row.pulse,row.weight,row.temperature,row.finger,row.hematocrit,row.protein,[row.arm? 'Donation arm: '+row.arm:'',row.duration===null?'':row.duration+' min'].filter(Boolean).join(' · '),row.notes];
    for(const value of values){const td=document.createElement('td');td.textContent=value===null?'':String(value);tr.append(td);}
    body.append(tr);
  }
}

function renderHistoryChart(){
  const svg=document.querySelector('#history-chart');
  svg.replaceChildren();
  svg.setAttribute('viewBox','0 0 760 650');
  const dated=records.filter(row=>validDate(row.date)).sort((a,b)=>(a.date+' '+a.time).localeCompare(b.date+' '+b.time));
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

async function persistCurrentVisit({finalize = false} = {}) {
  if(visitsLoadState!=='loaded')throw new Error('Your draft is saved on this device, but visit history is not loaded yet. Sign in and refresh before saving it to your visit history.');
  const input = Object.fromEntries(new FormData(form));
  const existing = activeRow() || records.find(row => row.id === activeVisitId);
  input.id = activeVisitId || existing?.id || makeVisitId();
  if (existing) input.source = existing.source;
  const merged = {...(existing || {}), ...input, id: input.id};
  const row = normalize(merged);
  const next = records.filter(record => visitKey(record) !== (editing || ''));
  const conflict = next.find(record => record.date === row.date && record.time === row.time && record.visitType === row.visitType);
  if (conflict) throw new Error('A visit already uses this date and time. Open that visit to update it.');
  await save([...next, row]);
  editing = visitKey(row);
  activeVisitId = row.id;
  creatingNew = !finalize;
  return row;
}
form.addEventListener('input',autoSaveCslDraft);
form.addEventListener('change',autoSaveCslDraft);
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#phase-save');
  button.disabled = true;
  try {
    const type = form.elements.visitType.value;
    if (type === 'CSL donation' && entryPhase === 'details') {
      if (!form.elements.finger.value || !form.elements.arm.value || !form.elements.hematocrit.value || !form.elements.protein.value) {
        throw new Error('Select the screening finger and donation arm, then enter hematocrit and total protein before continuing.');
      }
      const row = await persistCurrentVisit();
      entryPhase = 'duration';
      cancel.hidden = false;
      renderWorkflow();
      saveLocalCslDraft('duration');
      form.elements.duration.focus();
      status.textContent = 'Screening details saved to your visit history. Your in-progress visit is also saved on this device.';
      document.querySelector('#dashboard-status').textContent = '';
      return;
    }
    if (type === 'CSL donation' && entryPhase === 'duration') {
      const durationMinutes = Number(form.elements.duration.value);
      if (!form.elements.duration.value || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180) throw new Error('Enter a whole-number donation duration between 1 and 180 minutes.');
      const row = await persistCurrentVisit();
      entryPhase = 'scan';
      cancel.hidden = false;
      renderWorkflow();
      saveLocalCslDraft('scan');
      status.textContent = 'Duration saved to your visit history. Scan the CSL visit screenshot to add the remaining readings.';
      document.querySelector('#dashboard-status').textContent = '';
      return;
    }
    const row = await persistCurrentVisit({finalize:true});
    const draftCleared=clearLocalCslDraft();
    editing = null;
    activeVisitId = null;
    creatingNew = false;
    entryPhase = 'details';
    scanWasRead = false;
    resetForm();
    const message = 'Saved visit for ' + row.date + '.';
    status.textContent = draftCleared ? message : message + ' The local draft could not be cleared; refresh the app before starting another visit.';
    document.querySelector('#dashboard-status').textContent = message;
  } catch (error) {
    status.textContent = error.message || 'Could not save this visit.';
  } finally {
    button.disabled = false;
  }
});
cancel.addEventListener('click', () => {
  const hasDraft=saveLocalCslDraft(entryPhase);
  resetForm();
  status.textContent = hasDraft ? 'Visit entry closed. Your in-progress CSL draft is saved on this device for today.' : 'Visit entry closed. Any saved progress remains in Today’s Visits.';
});
document.querySelector('#phase-back').addEventListener('click', () => {
  if (entryPhase === 'scan') entryPhase = 'duration';
  else if (entryPhase === 'duration') entryPhase = 'details';
  else if (entryPhase === 'qrShow') entryPhase = 'qrCapture';
  else if (entryPhase === 'qrCapture') entryPhase = 'intake';
  renderWorkflow();
  saveLocalCslDraft(entryPhase);
});
form.elements.visitType.addEventListener('change', () => {
  clearScanSelection();
  clearLocalCslDraft();
  scanWasRead = false;
  const isCsl = form.elements.visitType.value === 'CSL donation';
  if (isCsl) {
    form.elements.arm.value = defaultArm();
    for (const name of ['time','systolic','diastolic','pulse','weight','temperature','duration','notes','finger']) form.elements[name].value = '';
    entryPhase = 'intake';
    status.textContent = 'CSL selected. Open the CSL intake form when you are ready.';
  } else {
    for (const name of ['time','systolic','diastolic','pulse','weight','temperature','hematocrit','protein','duration','arm','finger']) form.elements[name].value = '';
    entryPhase = 'other';
    status.textContent = 'Doctor or Other selected. CSL-only fields were cleared; scan a visit summary or enter notes.';
  }
  renderWorkflow();
});
document.querySelector('#add-new-visit').addEventListener('click', () => {
  if(activeCslDraft?.savedOn===localToday()){void restoreCslDraft();return;}
  resetForm();
  creatingNew = true;
  activeVisitId = makeVisitId();
  form.elements.id.value = activeVisitId;
  cancel.hidden = false;
  renderEntryDashboard();
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
  const headers={date:'Date',time:'Time',visitType:'Visit type',systolic:'Systolic BP',diastolic:'Diastolic BP',pulse:'Pulse (bpm)',weight:'Weight (lb)',temperature:'Temperature (°F)',hematocrit:'Hematocrit',protein:'Total protein (g/dL)',duration:'Duration (min)',finger:'Screening finger',arm:'Donation arm',notes:'Notes',source:'Source'};
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
    try { localStorage.removeItem(storageKey); } catch {}
    visitsLoadState='loaded';
    visitsLoadError='';
    document.querySelector('#connection-help').hidden=true;
    if(showHistoryStatus) historyStatus.textContent='History refreshed: '+records.length+' visits loaded.';
  } catch(error) {
    visitsLoadState='error';
    visitsLoadError=error.message;
    historyStatus.textContent=error.message;
    document.querySelector('#connection-help').hidden=false;
    renderLastVisitSummary();
  }
  drawReport();
}
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
    renderLastVisitSummary();
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
  const allReadings = records.filter(row => row.systolic !== null && row.diastolic !== null).sort((a,b)=>(a.date+' '+a.time).localeCompare(b.date+' '+b.time));
  const rangeCutoff = bpChartRange === 'all' ? '' : new Date(Date.now() - ({'3y':1095,'1y':365,'6m':183}[bpChartRange] || 0) * 86400000).toISOString().slice(0,10);
  const readings = rangeCutoff ? allReadings.filter(row => row.date >= rangeCutoff) : allReadings;
  const rangeCount=document.querySelector('#bp-chart-count');if(rangeCount)rangeCount.textContent=readings.length+' of '+allReadings.length+' readings';
  const svg = document.querySelector('#bp-chart');
  svg.replaceChildren();
  svg.setAttribute('viewBox','0 0 760 320');
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
  const plotLeft=58,plotRight=720,plotTop=42,plotBottom=238,axisY=264;
  const pointTime=row=>Date.parse(row.date+'T'+(row.time||'12:00')+':00Z');
  let minTime=Math.min(...readings.map(pointTime)),maxTime=Math.max(...readings.map(pointTime));
  if(minTime===maxTime){minTime-=43200000;maxTime+=43200000;}
  const xTime=time=>plotLeft+(time-minTime)/(maxTime-minTime)*(plotRight-plotLeft);
  const pressureValues=readings.flatMap(row=>[row.systolic,row.diastolic]);
  const low=Math.min(60,Math.floor((Math.min(...pressureValues)-10)/20)*20);
  const high=Math.max(180,Math.ceil((Math.max(...pressureValues)+10)/20)*20);
  const y=value=>plotBottom-(value-low)/(high-low)*(plotBottom-plotTop);
  for(let tick=low;tick<=high;tick+=20){
    const line=document.createElementNS(ns,'line');line.setAttribute('x1',plotLeft);line.setAttribute('x2',plotRight);line.setAttribute('y1',y(tick));line.setAttribute('y2',y(tick));line.setAttribute('stroke','#d8e2df');svg.append(line);
    const label=document.createElementNS(ns,'text');label.setAttribute('x',plotLeft-8);label.setAttribute('y',y(tick)+4);label.setAttribute('text-anchor','end');label.setAttribute('font-size','12');label.textContent=String(tick);svg.append(label);
  }
  const addSeries=(field,color,title)=>{
    const points=readings.map(row=>xTime(pointTime(row))+','+y(row[field])).join(' ');
    const poly=document.createElementNS(ns,'polyline');poly.setAttribute('points',points);poly.setAttribute('fill','none');poly.setAttribute('stroke',color);poly.setAttribute('stroke-width','2.5');svg.append(poly);
    readings.forEach(row=>{const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',xTime(pointTime(row)));dot.setAttribute('cy',y(row[field]));dot.setAttribute('r','3.5');dot.setAttribute('fill',color);dot.setAttribute('aria-label',row.date+(row.time?' '+row.time:'')+' '+title+' '+row[field]);svg.append(dot);});
  };
  addSeries('systolic','#b4422e','Systolic');addSeries('diastolic','#236a83','Diastolic');
  const firstDate=readings[0].date,lastDate=readings[readings.length-1].date;
  for(const event of medicationEvents){
    if(event.date<firstDate||event.date>lastDate)continue;
    const markerTime=Date.parse(event.date+'T12:00:00Z');
    const markerX=Math.max(plotLeft,Math.min(plotRight,xTime(markerTime)));
    const line=document.createElementNS(ns,'line');line.setAttribute('x1',markerX);line.setAttribute('x2',markerX);line.setAttribute('y1',plotTop);line.setAttribute('y2',plotBottom);line.setAttribute('stroke','#7d5b9b');line.setAttribute('stroke-dasharray','5 4');svg.append(line);
  }
  const axis=document.createElementNS(ns,'line');axis.setAttribute('x1',plotLeft);axis.setAttribute('x2',plotRight);axis.setAttribute('y1',axisY);axis.setAttribute('y2',axisY);axis.setAttribute('stroke','#617777');svg.append(axis);
  for(let index=0;index<=4;index++){
    const time=minTime+(maxTime-minTime)*index/4;const tickX=xTime(time);
    const mark=document.createElementNS(ns,'line');mark.setAttribute('x1',tickX);mark.setAttribute('x2',tickX);mark.setAttribute('y1',axisY);mark.setAttribute('y2',axisY+5);mark.setAttribute('stroke','#617777');svg.append(mark);
    const date=new Date(time);const labelText=(maxTime-minTime)>3*365*86400000?String(date.getUTCFullYear()):date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'2-digit',timeZone:'UTC'});
    const label=document.createElementNS(ns,'text');label.setAttribute('x',tickX);label.setAttribute('y',axisY+20);label.setAttribute('text-anchor',index===0?'start':index===4?'end':'middle');label.setAttribute('font-size','11');label.setAttribute('fill','#4d6364');label.textContent=labelText;svg.append(label);
  }
  const legend=document.createElementNS(ns,'text');legend.setAttribute('x',plotRight);legend.setAttribute('y',22);legend.setAttribute('text-anchor','end');legend.setAttribute('font-size','12');legend.textContent='● Systolic   ● Diastolic   ⋮ Medication';svg.append(legend);
  const periods=[['Before Feb 25, 2026',r=>r.date<'2026-02-25'],['Feb 25–May 31, 2026',r=>r.date>='2026-02-25'&&r.date<'2026-06-01'],['Jun 1, 2026 onward',r=>r.date>='2026-06-01']];
  const summary=document.querySelector('#period-summary');summary.replaceChildren();
  for(const [name,include] of periods){const subset=readings.filter(include);const box=document.createElement('div');if(subset.length){const mean=key=>Math.round(subset.reduce((total,row)=>total+row[key],0)/subset.length);box.textContent=name+' · '+subset.length+' readings · average '+mean('systolic')+'/'+mean('diastolic')+' mm Hg';}else box.textContent=name+' · no readings';summary.append(box);}
}
drawReport();
function svgObjectUrl(svg){const copy=svg.cloneNode(true);const box=copy.viewBox.baseVal;copy.setAttribute('width',String(box.width||760));copy.setAttribute('height',String(box.height||320));return URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml;charset=utf-8'}));}
function wrapCanvasText(ctx,text,x,y,maxWidth,lineHeight){
  let line='';
  for(const word of String(text).split(/\s+/)){const candidate=line?line+' '+word:word;if(ctx.measureText(candidate).width>maxWidth&&line){ctx.fillText(line,x,y);line=word;y+=lineHeight;}else line=candidate;}
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
  ctx.font='23px system-ui,sans-serif';
  for(const item of medText){ctx.fillStyle='#fff5f1';ctx.fillRect(72,y-32,1096,78);ctx.fillStyle='#17252b';y=wrapCanvasText(ctx,item,92,y,1045,31)+12;}
  const reportStatus=document.querySelector('#report-load-status')?.textContent?.trim();ctx.fillStyle='#526567';ctx.font='21px system-ui,sans-serif';y=wrapCanvasText(ctx,reportStatus||'',72,y+10,1096,29);
  ctx.fillStyle='#17252b';ctx.font='bold 25px system-ui,sans-serif';ctx.fillText('Blood pressure trend',72,y+36);
  const svg=document.querySelector('#bp-chart');const url=svgObjectUrl(svg);
  try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});ctx.drawImage(image,72,y+55,1096,1096*320/760);}finally{URL.revokeObjectURL(url);}
  y+=560;ctx.fillStyle='#526567';ctx.font='22px system-ui,sans-serif';
  for(const item of [...document.querySelectorAll('#period-summary>*')]){y=wrapCanvasText(ctx,item.textContent,72,y,1096,31)+14;}
  ctx.font='18px system-ui,sans-serif';ctx.fillStyle='#667';ctx.fillText('Prepared '+new Date().toLocaleDateString(),72,1688);
  const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));if(!jpeg)throw new Error('PDF image creation failed');
  const jpg=new Uint8Array(await jpeg.arrayBuffer());const enc=new TextEncoder();const parts=[];let size=0;const offsets=[0];const NL=String.fromCharCode(10);
  const push=chunk=>{const bytes=typeof chunk==='string'?enc.encode(chunk):chunk;parts.push(bytes);size+=bytes.length;};
  push('%PDF-1.4'+NL+'%PDFbinary'+NL);
  const objects=[
    '1 0 obj'+NL+'<< /Type /Catalog /Pages 2 0 R >>'+NL+'endobj'+NL,
    '2 0 obj'+NL+'<< /Type /Pages /Kids [3 0 R] /Count 1 >>'+NL+'endobj'+NL,
    '3 0 obj'+NL+'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'+NL+'endobj'+NL,
    null,
    '5 0 obj'+NL+'<< /Length 30 >>'+NL+'stream'+NL+'q 595 0 0 842 0 0 cm /Im0 Do Q'+NL+'endstream'+NL+'endobj'+NL
  ];
  for(let i=0;i<objects.length;i++){offsets.push(size);if(i===3){push('4 0 obj'+NL+'<< /Type /XObject /Subtype /Image /Width '+canvas.width+' /Height '+canvas.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+jpg.length+' >>'+NL+'stream'+NL);push(jpg);push(NL+'endstream'+NL+'endobj'+NL);}else push(objects[i]);}
  const xref=size;push('xref'+NL+'0 6'+NL+'0000000000 65535 f '+NL);for(let i=1;i<=5;i++)push(String(offsets[i]).padStart(10,'0')+' 00000 n '+NL);push('trailer'+NL+'<< /Size 6 /Root 1 0 R >>'+NL+'startxref'+NL+xref+NL+'%%EOF');
  return new Blob(parts,{type:'application/pdf'});
}
document.querySelector('#print-report').addEventListener('click',async()=>{
  const status=document.querySelector('#export-status');const button=document.querySelector('#print-report');button.disabled=true;status.textContent='Preparing your report PDF…';
  try{const pdf=await createReportPdf();const file=new File([pdf],'blood-pressure-report.pdf',{type:'application/pdf'});if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Blood pressure report'});status.textContent='Use the share menu to save the PDF to Files or choose Print.';}else{const url=URL.createObjectURL(pdf);const link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status.textContent='Report PDF downloaded. Open it to save or print.';}}catch(error){if(error.name!=='AbortError')status.textContent='Could not create the report PDF. Please try again.';}finally{button.disabled=false;}
});
document.querySelector('#save-chart-image').addEventListener('click',async()=>{
  const status=document.querySelector('#export-status');const svg=document.querySelector('#bp-chart');
  if(!svg.querySelector('polyline')){status.textContent='Load blood pressure readings before saving the chart image.';return;}
  try{
    const url=svgObjectUrl(svg);
    const image=new Image();
    image.onload=async()=>{
      try{
        const box=svg.viewBox.baseVal;const canvas=document.createElement('canvas');canvas.width=1520;canvas.height=Math.round(canvas.width*(box.height||320)/(box.width||760));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
        const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!png)throw new Error('Image export failed');
        const file=new File([png],'blood-pressure-trend.png',{type:'image/png'});
        if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Blood pressure trend'});status.textContent='Choose Save Image in the share sheet to add the graph to Photos.';}
        else{const objectUrl=URL.createObjectURL(png);const link=document.createElement('a');link.href=objectUrl;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);status.textContent='Chart image downloaded. Open it and use Share → Save Image to add it to Photos.';}
      }catch(error){if(error.name!=='AbortError')status.textContent='Could not create the image. Please try again.';}
      finally{URL.revokeObjectURL(url);}
    };
    image.onerror=()=>{URL.revokeObjectURL(url);status.textContent='Could not create the image. Please try again.';};
    image.src=url;
  }catch{status.textContent='Could not create the image. Please try again.';}
});
document.querySelector('#trend-range').addEventListener('change',drawMetricTrend);
document.querySelector('#bp-chart-range').addEventListener('change',event=>{bpChartRange=event.target.value;drawReport();});
const chartToggle=document.querySelector('#toggle-bp-chart');
chartToggle.addEventListener('click',()=>{
  const panel=document.querySelector('#bp-chart-panel');
  panel.hidden=!panel.hidden;
  chartToggle.setAttribute('aria-expanded',String(!panel.hidden));
  chartToggle.textContent=panel.hidden?'Show BP graph':'Hide BP graph';
});

const qrImage=document.querySelector('#qr-image');
const qrPreview=document.querySelector('#qr-preview');
const qrDisplay=document.querySelector('#qr-display');
const qrUseButton=document.querySelector('#use-qr');
const qrChooseButton=document.querySelector('#choose-qr-image');
const qrPasteButton=document.querySelector('#paste-qr-image');
const qrCropActions=document.querySelector('#qr-crop-actions');
const qrStatus=document.querySelector('#qr-status');
const qrCropButton=document.querySelector('#crop-qr');
const qrCropEditor=document.querySelector('#qr-crop-editor');
const qrCropFrame=document.querySelector('#qr-crop-frame');
const qrCropSource=document.querySelector('#qr-crop-source');
const qrCropSelection=document.querySelector('#qr-crop-selection');
const qrApplyCropButton=document.querySelector('#apply-qr-crop');
const qrUseFullButton=document.querySelector('#use-full-qr');
let qrSourceUrl='';
let qrDragStart=null;
let qrCropRect=null;
function replaceQrPreviewUrl(url){
  if(qrPreviewUrl&&qrPreviewUrl!==qrSourceUrl)URL.revokeObjectURL(qrPreviewUrl);
  qrPreviewUrl=url;
  qrPreview.src=url;
  qrPreview.hidden=false;
  qrDisplay.src=url;
  qrDisplay.hidden=true;
}
function clearQrSelection(){
  for(const url of new Set([qrPreviewUrl,qrSourceUrl]))if(url)URL.revokeObjectURL(url);
  qrPreviewUrl='';
  qrSourceUrl='';
  qrCropRect=null;
  qrDragStart=null;
  qrPreview.removeAttribute('src');
  qrPreview.hidden=true;
  qrDisplay.removeAttribute('src');
  qrDisplay.hidden=true;
  qrCropSource.removeAttribute('src');
  qrCropEditor.hidden=true;
  qrCropActions.hidden=true;
  qrCropSelection.hidden=true;
  qrApplyCropButton.disabled=true;
  qrCropButton.disabled=true;
  qrImage.value='';
  qrUseButton.disabled=true;
  document.querySelector('#qr-file-name').textContent='No QR screenshot selected yet';
  qrStatus.textContent='';
}
async function selectQrImage(file){
  if(!file)return false;
  if(!file.type.startsWith('image/')){clearQrSelection();qrStatus.textContent='Choose an image screenshot of the CSL QR code.';return false;}
  if(file.size>20*1024*1024){clearQrSelection();qrStatus.textContent='This image is over 20 MB. Choose a smaller screenshot.';return false;}
  clearQrSelection();
  qrSourceUrl=URL.createObjectURL(file);
  qrCropSource.src=qrSourceUrl;
  replaceQrPreviewUrl(URL.createObjectURL(file));
  document.querySelector('#qr-file-name').textContent=file.name||'Image from clipboard';
  qrUseButton.disabled=true;
  qrChooseButton.disabled=true;
  qrPasteButton.disabled=true;
  qrStatus.textContent='Finding and cropping the QR code on this device…';
  try{
    await qrCropSource.decode();
    const cropped=await detectAndCropQr(qrCropSource);
    if(!cropped)throw new Error('QR code not detected');
    replaceQrPreviewUrl(URL.createObjectURL(cropped));
    qrCropEditor.hidden=true;
    qrCropActions.hidden=true;
    qrUseButton.disabled=false;
    qrStatus.textContent='QR code detected and cropped for the front desk. The image stays on this device.';
  }catch(error){
    qrCropActions.hidden=false;
    qrCropButton.disabled=false;
    qrCropEditor.hidden=true;
    qrUseButton.disabled=true;
    qrStatus.textContent='Could not detect the QR automatically. Tap “Adjust QR crop” to select it manually.';
  }finally{
    qrChooseButton.disabled=false;
    qrPasteButton.disabled=false;
  }
  return true;
}
async function detectAndCropQr(image){
  if(typeof window.jsQR!=='function')throw new Error('QR detector unavailable');
  const sourceWidth=image.naturalWidth,sourceHeight=image.naturalHeight;
  const scanScale=Math.min(1,1800/Math.max(sourceWidth,sourceHeight));
  const scanWidth=Math.max(1,Math.round(sourceWidth*scanScale));
  const scanHeight=Math.max(1,Math.round(sourceHeight*scanScale));
  const scanCanvas=document.createElement('canvas');
  scanCanvas.width=scanWidth;scanCanvas.height=scanHeight;
  const scanContext=scanCanvas.getContext('2d',{willReadFrequently:true});
  if(!scanContext)throw new Error('Image processing is unavailable');
  scanContext.drawImage(image,0,0,scanWidth,scanHeight);
  const pixels=scanContext.getImageData(0,0,scanWidth,scanHeight);
  const code=window.jsQR(pixels.data,scanWidth,scanHeight,{inversionAttempts:'attemptBoth'});
  if(!code?.location)throw new Error('QR code not detected');
  const points=['topLeftCorner','topRightCorner','bottomLeftCorner','bottomRightCorner'].map(key=>code.location[key]).filter(Boolean);
  if(points.length<4)throw new Error('QR boundary unavailable');
  const bounds={
    left:Math.min(...points.map(point=>point.x))/scanScale,
    right:Math.max(...points.map(point=>point.x))/scanScale,
    top:Math.min(...points.map(point=>point.y))/scanScale,
    bottom:Math.max(...points.map(point=>point.y))/scanScale
  };
  const width=bounds.right-bounds.left,height=bounds.bottom-bounds.top;
  let side=Math.min(Math.max(width,height)*1.22,sourceWidth,sourceHeight);
  if(side<48)throw new Error('QR code is too small to crop');
  const centerX=(bounds.left+bounds.right)/2,centerY=(bounds.top+bounds.bottom)/2;
  const sourceX=Math.max(0,Math.min(sourceWidth-side,centerX-side/2));
  const sourceY=Math.max(0,Math.min(sourceHeight-side,centerY-side/2));
  const outputSide=Math.max(512,Math.min(1200,Math.round(side)));
  const output=document.createElement('canvas');
  output.width=outputSide;output.height=outputSide;
  const context=output.getContext('2d');
  if(!context)throw new Error('Image processing is unavailable');
  context.imageSmoothingEnabled=true;
  context.imageSmoothingQuality='high';
  context.drawImage(image,sourceX,sourceY,side,side,0,0,outputSide,outputSide);
  return await new Promise((resolve,reject)=>output.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not create cropped image')),'image/png'));
}
function openCslIntakePage(){
  window.open('https://donor360.cslplasma.com/profile','_blank','noopener,noreferrer');
}
document.querySelector('#open-csl-intake').addEventListener('click',()=>{
  entryPhase='qrCapture';
  clearQrSelection();
  renderWorkflow();
  qrStatus.textContent='Complete the CSL intake in the other tab. When you return, choose the saved QR screenshot or paste it from the clipboard.';
});
document.querySelector('#choose-qr-image').addEventListener('click',()=>qrImage.click());
qrImage.addEventListener('change',()=>{void selectQrImage(qrImage.files?.[0]);});
qrPasteButton.addEventListener('click',async()=>{
  qrPasteButton.disabled=true;
  qrStatus.textContent='Checking clipboard for an image…';
  try{
    if(!navigator.clipboard?.read)throw new Error('Image paste is not supported in this browser. Use Photo library or Choose file instead.');
    const items=await navigator.clipboard.read();
    for(const item of items){
      const imageType=item.types.find(type=>type.startsWith('image/'));
      if(!imageType)continue;
      const blob=await item.getType(imageType);
      const extension=imageType.split('/')[1]?.replace('jpeg','jpg')||'png';
      const file=new File([blob],'csl-check-in-qr.'+extension,{type:imageType});
      if(await selectQrImage(file))return;
    }
    qrStatus.textContent='No image was found on the clipboard. Copy a screenshot of your CSL QR code, then try again.';
  }catch(error){
    qrStatus.textContent=error?.name==='NotAllowedError'
      ? 'Clipboard access was denied. Allow paste when your browser asks, then try again. You can also choose the image from Photo Library or Files.'
      : (error?.message||'Could not read an image from the clipboard. Choose the screenshot instead.');
  }finally{
    qrPasteButton.disabled=false;
  }
});
qrCropButton.addEventListener('click',()=>{
  qrCropEditor.hidden=false;
  qrCropSelection.hidden=true;
  qrCropRect=null;
  qrApplyCropButton.disabled=true;
  qrStatus.textContent='Drag around the QR code, keeping all four corner squares inside the selection.';
});
function qrCropPoint(event){
  const rect=qrCropFrame.getBoundingClientRect();
  return {x:Math.max(0,Math.min(rect.width,event.clientX-rect.left)),y:Math.max(0,Math.min(rect.height,event.clientY-rect.top))};
}
function updateQrCropSelection(point){
  const x=Math.min(qrDragStart.x,point.x),y=Math.min(qrDragStart.y,point.y);
  const width=Math.abs(point.x-qrDragStart.x),height=Math.abs(point.y-qrDragStart.y);
  qrCropSelection.style.left=x+'px';
  qrCropSelection.style.top=y+'px';
  qrCropSelection.style.width=width+'px';
  qrCropSelection.style.height=height+'px';
  qrCropSelection.hidden=false;
  qrCropRect={x,y,width,height};
  qrApplyCropButton.disabled=width<36||height<36;
}
qrCropFrame.addEventListener('pointerdown',event=>{
  if(!qrCropSource.naturalWidth)return;
  event.preventDefault();
  qrCropFrame.setPointerCapture(event.pointerId);
  qrDragStart=qrCropPoint(event);
  updateQrCropSelection(qrDragStart);
});
qrCropFrame.addEventListener('pointermove',event=>{
  if(qrDragStart)updateQrCropSelection(qrCropPoint(event));
});
function finishQrCropDrag(event){
  if(!qrDragStart)return;
  updateQrCropSelection(qrCropPoint(event));
  qrDragStart=null;
  if(!qrApplyCropButton.disabled)qrStatus.textContent='QR area selected. Review the square crop, then use it for the desk screen.';
}
qrCropFrame.addEventListener('pointerup',finishQrCropDrag);
qrCropFrame.addEventListener('pointercancel',finishQrCropDrag);
qrApplyCropButton.addEventListener('click',()=>{
  if(!qrCropRect||qrApplyCropButton.disabled)return;
  const frame=qrCropFrame.getBoundingClientRect();
  const scaleX=qrCropSource.naturalWidth/frame.width;
  const scaleY=qrCropSource.naturalHeight/frame.height;
  const centerX=(qrCropRect.x+qrCropRect.width/2)*scaleX;
  const centerY=(qrCropRect.y+qrCropRect.height/2)*scaleY;
  const requestedSide=Math.max(qrCropRect.width*scaleX,qrCropRect.height*scaleY)*1.14;
  const side=Math.min(requestedSide,qrCropSource.naturalWidth,qrCropSource.naturalHeight);
  const sourceX=Math.max(0,Math.min(qrCropSource.naturalWidth-side,centerX-side/2));
  const sourceY=Math.max(0,Math.min(qrCropSource.naturalHeight-side,centerY-side/2));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(side));
  canvas.height=canvas.width;
  const context=canvas.getContext('2d');
  if(!context){qrStatus.textContent='Could not crop this image. Try another screenshot.';return;}
  context.imageSmoothingEnabled=false;
  context.drawImage(qrCropSource,sourceX,sourceY,side,side,0,0,canvas.width,canvas.height);
  canvas.toBlob(blob=>{
    if(!blob){qrStatus.textContent='Could not create the cropped QR image. Try again.';return;}
    replaceQrPreviewUrl(URL.createObjectURL(blob));
    qrCropEditor.hidden=true;
    qrUseButton.disabled=false;
    qrStatus.textContent='QR cropped for a large desk display. It stays in this browser only.';
  },'image/png');
});
qrUseFullButton.addEventListener('click',()=>{
  if(!qrSourceUrl)return;
  replaceQrPreviewUrl(qrSourceUrl);
  qrCropEditor.hidden=true;
  qrUseButton.disabled=false;
  qrStatus.textContent='Using the full screenshot. If the QR looks small at the desk, crop around it first.';
});
const pendingQrDbName='donation-log-local-checkin-v1';
let pendingQrPersisted=false;
function openPendingQrDb(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)){reject(new Error('This browser does not support local QR storage.'));return;}
    const request=indexedDB.open(pendingQrDbName,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains('checkins'))request.result.createObjectStore('checkins');
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Could not open local QR storage.'));
  });
}
async function savePendingQr(value){
  const db=await openPendingQrDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('checkins','readwrite');
    tx.objectStore('checkins').put(value,'active');
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error||new Error('Could not save the QR on this device.'));
    tx.onabort=()=>reject(tx.error||new Error('Could not save the QR on this device.'));
  }).finally(()=>db.close());
}
const pendingQrLocalKey='donation-log-pending-checkin-v1';
function usablePendingQr(saved){
  const blob=saved?.blob;
  return Boolean(blob&&typeof blob.size==='number'&&blob.size>0);
}
function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||''));
    reader.onerror=()=>reject(reader.error||new Error('Could not prepare local QR backup.'));
    reader.readAsDataURL(blob);
  });
}
async function readPendingQr(){
  try{
    const db=await openPendingQrDb();
    const saved=await new Promise((resolve,reject)=>{
      const tx=db.transaction('checkins','readonly');
      const request=tx.objectStore('checkins').get('active');
      let result=null;
      request.onsuccess=()=>{result=request.result||null;};
      request.onerror=()=>reject(request.error||new Error('Could not read the saved QR.'));
      tx.oncomplete=()=>{db.close();resolve(result);};
      tx.onerror=()=>reject(tx.error||new Error('Could not read the saved QR.'));
      tx.onabort=()=>reject(tx.error||new Error('Could not read the saved QR.'));
    });
    if(usablePendingQr(saved))return saved;
  }catch(error){}
  try{
    const saved=JSON.parse(localStorage.getItem(pendingQrLocalKey)||'null');
    if(saved?.dataUrl&&typeof saved.dataUrl==='string'){
      const blob=await fetch(saved.dataUrl).then(response=>response.blob());
      if(blob.size)return {...saved,blob,storage:'local'};
    }
  }catch(error){}
  return null;
}
async function saveLocalPendingQr(value){
  const dataUrl=await blobToDataUrl(value.blob);
  // Keep a conservative margin below typical per-origin localStorage limits.
  if(dataUrl.length>4_000_000)throw new Error('QR image is too large for the local backup.');
  const backup={date:value.date,id:value.id,arm:value.arm,savedAt:value.savedAt,dataUrl};
  localStorage.setItem(pendingQrLocalKey,JSON.stringify(backup));
  const check=JSON.parse(localStorage.getItem(pendingQrLocalKey)||'null');
  if(check?.date!==value.date||check?.dataUrl!==dataUrl)throw new Error('Could not verify the local QR backup.');
}
async function clearPendingQr(){
  localStorage.removeItem(pendingQrLocalKey);
  const db=await openPendingQrDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('checkins','readwrite');
    tx.objectStore('checkins').delete('active');
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error||new Error('Could not clear the saved QR.'));
    tx.onabort=()=>reject(tx.error||new Error('Could not clear the saved QR.'));
  }).finally(()=>db.close());
}
async function restorePendingQr(){
  try{
    const saved=await readPendingQr();
    if(!saved)return false;
    const blob=usablePendingQr(saved)?saved.blob:null;
    if(saved.date!==localToday()||!blob){
      await clearPendingQr().catch(()=>localStorage.removeItem(pendingQrLocalKey));
      document.querySelector('#dashboard-status').textContent='The saved CSL QR is no longer valid for today. Start a new visit to get a current code.';
      return false;
    }
    activeVisitId=saved.id||makeVisitId();
    creatingNew=true;
    pendingQrPersisted=true;
    form.elements.id.value=activeVisitId;
    form.elements.date.value=saved.date;
    form.elements.visitType.value='CSL donation';
    form.elements.arm.value=saved.arm||defaultArm();
    entryPhase='qrShow';
    qrSourceUrl=URL.createObjectURL(blob);
    replaceQrPreviewUrl(URL.createObjectURL(blob));
    document.querySelector('#qr-file-name').textContent='Saved on this device';
    renderWorkflow();
    renderEntryDashboard();
    status.textContent='Your CSL check-in QR is ready. Show it at the front desk.';
    return true;
  }catch(error){
    document.querySelector('#dashboard-status').textContent='Could not restore the saved CSL QR on this device. You can choose it again from the screenshot or clipboard.';
    return false;
  }
}
qrUseButton.addEventListener('click',async()=>{
  if(!qrPreviewUrl||qrUseButton.disabled)return;
  qrUseButton.disabled=true;
  status.textContent='Saving your check-in QR on this device…';
  let saved=false;
  try{
    const response=await fetch(qrPreviewUrl);
    if(!response.ok)throw new Error('Could not read the selected QR image.');
    const blob=await response.blob();
    if(!blob.size)throw new Error('The selected QR image is empty.');
    const pendingId=activeVisitId||form.elements.id.value||makeVisitId();
    const value={blob,date:form.elements.date.value,id:pendingId,arm:form.elements.arm.value,savedAt:Date.now()};
    try{
      await savePendingQr(value);
      const check=await readPendingQr();
      if(!usablePendingQr(check)||check.date!==value.date||check.id!==value.id)throw new Error('Could not verify the saved QR.');
      saved=true;
    }catch(error){}
    try{await saveLocalPendingQr(value);saved=true;}catch(error){}
    if(!saved)throw new Error('Local storage could not be verified.');
    activeVisitId=pendingId;
    form.elements.id.value=activeVisitId;
    pendingQrPersisted=true;
    entryPhase='qrShow';
    renderWorkflow();
    renderEntryDashboard();
    status.textContent='Your QR is saved on this device for today. Reopen Donation Log to show it at the front desk.';
  }catch(error){
    status.textContent='The QR was not saved, so this screen has stayed here. Check available iPhone storage and tap “Use this QR code” again.';
    qrUseButton.disabled=false;
  }
});
document.querySelector('#qr-checked-in').addEventListener('click',async()=>{
  const button=document.querySelector('#qr-checked-in');
  button.disabled=true;
  if(pendingQrPersisted){
    try{await clearPendingQr();pendingQrPersisted=false;}
    catch(error){button.disabled=false;status.textContent='Could not clear the saved QR. Keep this screen open and try again.';return;}
  }
  clearQrSelection();
  entryPhase='details';
  renderWorkflow();
  renderEntryDashboard();
  saveLocalCslDraft('details');
  form.elements.arm.focus();
  status.textContent='Check-in complete. Enter your arm, hematocrit, and total protein before donating. Progress saves on this device as you enter it.';
});
const scanImage=document.querySelector('#scan-image');
const scanReadButton=document.querySelector('#scan-read');
const scanPreview=document.querySelector('#scan-preview');
const scanStatus=document.querySelector('#scan-status');
const scanResults=document.querySelector('#scan-results');
const scanFindings=document.querySelector('#scan-findings');
const scanOcrDetails=document.querySelector('#scan-ocr-debug');
const scanOcrText=document.querySelector('#scan-ocr-text');
const scanOcrCopyButton=document.querySelector('#copy-scan-ocr');
const scanOcrCopyStatus=document.querySelector('#scan-ocr-copy-status');
const scanResultsNode=document.querySelector('#scan-results');
const strayScanText=scanResultsNode?.nextSibling;
if(strayScanText?.nodeType===Node.TEXT_NODE&&strayScanText.textContent.trim()==='\\n')strayScanText.remove();
let scanPreviewUrl='';
let tesseractScriptPromise=null;

let scanSelectedFile=null;
function clearScanSelection(){
  if(scanPreviewUrl)URL.revokeObjectURL(scanPreviewUrl);
  scanPreviewUrl='';
  scanSelectedFile=null;
  scanPreview.removeAttribute('src');
  scanPreview.hidden=true;
  scanImage.value='';
  scanReadButton.disabled=true;
  document.querySelector('#scan-file-name').textContent='No screenshot selected yet';
  scanStatus.textContent='';
  scanResults.hidden=true;
  scanFindings.replaceChildren();
  scanOcrDetails.hidden=true;
  scanOcrText.textContent='';
}
function acceptScanImage(file){
  if(!file)return false;
  if(!file.type.startsWith('image/')){
    clearScanSelection();
    scanStatus.textContent='Choose an image file such as a CSL screenshot.';
    return false;
  }
  if(file.size>20*1024*1024){
    clearScanSelection();
    scanStatus.textContent='This image is over 20 MB. Choose a smaller screenshot.';
    return false;
  }
  if(scanPreviewUrl)URL.revokeObjectURL(scanPreviewUrl);
  scanSelectedFile=file;
  scanPreviewUrl=URL.createObjectURL(file);
  scanPreview.src=scanPreviewUrl;
  scanPreview.hidden=false;
  document.querySelector('#scan-file-name').textContent=file.name;
  scanReadButton.disabled=false;
  scanResults.hidden=true;
  scanFindings.replaceChildren();
  scanStatus.textContent='Screenshot ready. Tap “Read screenshot” to extract possible readings.';
  return true;
}
document.querySelector('#choose-scan-image').addEventListener('click',()=>scanImage.click());
scanImage.addEventListener('change',()=>acceptScanImage(scanImage.files?.[0]));
document.querySelector('#paste-scan-image').addEventListener('click',async event=>{
  const button=event.currentTarget;
  button.disabled=true;
  scanStatus.textContent='Checking clipboard for an image…';
  try{
    if(!navigator.clipboard?.read)throw new Error('Image paste is not supported in this browser. Use Photo library or Choose file instead.');
    const items=await navigator.clipboard.read();
    for(const item of items){
      const imageType=item.types.find(type=>type.startsWith('image/'));
      if(!imageType)continue;
      const blob=await item.getType(imageType);
      const extension=imageType.split('/')[1]?.replace('jpeg','jpg')||'png';
      if(acceptScanImage(new File([blob],'csl-visit-summary.'+extension,{type:imageType})))return;
    }
    scanStatus.textContent='No image was found on the clipboard. Copy a screenshot of your CSL visit summary, then try again.';
  }catch(error){
    scanStatus.textContent=error?.name==='NotAllowedError'
      ? 'Clipboard access was denied. Allow paste when your browser asks, then try again. You can also choose the image from Photo Library or Files.'
      : (error?.message||'Could not read an image from the clipboard. Choose the screenshot instead.');
  }finally{button.disabled=false;}
});

async function prepareScanImage(file){
  try{
    const url=URL.createObjectURL(file);
    try{
      const image=new Image();
      await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
      const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
      if(!width||!height)return file;
      const scale=Math.min(2.5,Math.max(1,1800/width),Math.sqrt(8000000/(width*height)));
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
      const context=canvas.getContext('2d');if(!context)return file;
      context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
      context.filter='contrast(1.15)';context.drawImage(image,0,0,canvas.width,canvas.height);
      return await new Promise(resolve=>canvas.toBlob(blob=>resolve(blob||file),'image/png'));
    }finally{URL.revokeObjectURL(url);}
  }catch{return file;}
}
async function cropScanImage(file,topRatio,heightRatio){
  let url='';
  try{
    url=URL.createObjectURL(file);
    const image=new Image();
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
    const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
    const y=Math.max(0,Math.round(height*topRatio));
    const cropHeight=Math.min(height-y,Math.round(height*heightRatio));
    if(!width||cropHeight<1)return null;
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=cropHeight;
    const context=canvas.getContext('2d');if(!context)return null;
    context.fillStyle='#fff';context.fillRect(0,0,width,cropHeight);
    context.filter='contrast(1.2)';
    context.drawImage(image,0,y,width,cropHeight,0,0,width,cropHeight);
    return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  }catch{return null;}
  finally{if(url)URL.revokeObjectURL(url);}
}
function scanFieldCount(found){
  return [found.date,found.time,found.systolic,found.diastolic,found.pulse,found.weight,found.temperature]
    .filter(value=>value!==null&&value!==undefined&&value!=='').length;
}
function mergeScanFindings(primary,secondary){
  const merged={...primary};
  for(const field of ['date','time','systolic','diastolic','pulse','weight','temperature'])
    if(merged[field]===null||merged[field]===undefined||merged[field]==='')merged[field]=secondary[field];
  return merged;
}
function loadTesseract(){
  if(window.Tesseract)return Promise.resolve(window.Tesseract);
  if(!tesseractScriptPromise){
    tesseractScriptPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      script.crossOrigin='anonymous';
      script.onload=()=>window.Tesseract?resolve(window.Tesseract):reject(new Error('The OCR library did not load.'));
      script.onerror=()=>reject(new Error('Could not download the OCR library. Check your internet connection and try again.'));
      document.head.append(script);
    }).catch(error=>{tesseractScriptPromise=null;throw error;});
  }
  return tesseractScriptPromise;
}

function ocrSection(text,label,nextLabels){
  const match=label.exec(text);
  if(!match)return '';
  const contentStart=match.index+match[0].length;
  let contentEnd=text.length;
  for(const next of nextLabels){
    const found=next.exec(text);
    if(found&&found.index>=contentStart&&found.index<contentEnd)contentEnd=found.index;
  }
  return text.slice(contentStart,contentEnd);
}

function parseDonationScreenshot(text){
  const normalized=text.replace(/\r/g,'\n').replace(/[|]/g,'/').replace(/[•·]/g,' ');
  const parseMetric=(label,nextLabels,valuePattern)=>{
    const section=ocrSection(normalized,label,nextLabels);
    const match=valuePattern.exec(section);
    return match?match.slice(1):null;
  };
  const dateMatch=normalized.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})[,.]?\s*(20\d{2})\b/i);
  let date='';
  if(dateMatch){
    const month=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(dateMatch[1].toLowerCase());
    date=dateMatch[3]+'-'+String(month+1).padStart(2,'0')+'-'+String(Number(dateMatch[2])).padStart(2,'0');
  } else {
    const numericDate=normalized.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
    if(numericDate&&Number(numericDate[1])<=12&&Number(numericDate[2])<=31)date=numericDate[3]+'-'+String(Number(numericDate[1])).padStart(2,'0')+'-'+String(Number(numericDate[2])).padStart(2,'0');
  }
  const timeMatches=[...normalized.matchAll(/\b(\d{1,2})\s*[:.]?\s*(\d{2})\s*(AM|PM)\b/gi)];
  const rawTime=timeMatches.at(-1);
  let time='';
  if(rawTime){
    let hour=Number(rawTime[1])%12;
    if(rawTime[3].toUpperCase()==='PM')hour+=12;
    time=String(hour).padStart(2,'0')+':'+rawTime[2];
  }
  const bp=parseMetric(/Blood\s*Pressure\b/i,[/Pulse\s*Rate\b/i,/Weight\b/i,/Temperature\b/i],/(\d{2,3})\s*[/:]\s*(\d{2,3})/);
  const weight=parseMetric(/Weight\b/i,[/Blood\s*Pressure\b/i,/Pulse\s*Rate\b/i,/Temperature\b/i],/(\d{2,3})\s*(?:lbs?\b|pounds?\b)/i);
  const pulse=parseMetric(/Pulse\s*Rate\b/i,[/Weight\b/i,/Blood\s*Pressure\b/i,/Temperature\b/i],/(\d{2,3})\s*(?:beats?\s*\/\s*min|bpm)\b/i);
  const temperature=parseMetric(/Temperature\b/i,[/Weight\b/i,/Blood\s*Pressure\b/i,/Pulse\s*Rate\b/i],/(\d{2,3}(?:[.,]\d)?)\s*(?:°\s*)?F\b/i);
  const genericBp=normalized.match(/\b(?:blood\s*pressure|BP)\b[^\d]{0,24}(\d{2,3})\s*[/:]\s*(\d{2,3})/i);
  const unitBp=normalized.match(/\b(\d{2,3})\s*(?:\/|[|Il])?\s*(\d{2,3})\s*mm\s*Hg\b/i);
  const genericPulse=normalized.match(/\b(?:pulse(?:\s*rate)?|heart\s*rate)\b[^\d]{0,24}(\d{2,3})/i);
  const genericWeight=normalized.match(/\bweight\b[^\d]{0,18}(\d{2,3}(?:[.,]\d)?)\s*(?:lbs?|pounds?)?/i);
  const unitWeight=normalized.match(/\b(\d{2,3}(?:[.,]\d)?)\s*(?:lbs?|pounds?)\b/i);
  const genericTemperature=normalized.match(/\btemperature\b[^\d]{0,18}(\d{2,3}(?:[.,]\d)?)\s*(?:°\s*)?(?:F|fahrenheit)\b/i);
  const bpValues=bp||genericBp?.slice(1)||unitBp?.slice(1)||null;
  const pulseValue=pulse||genericPulse?.slice(1)||null;
  const weightValue=weight||genericWeight?.slice(1)||unitWeight?.slice(1)||null;
  const temperatureValue=temperature||genericTemperature?.slice(1)||null;
  const number=(value,min,max,decimals=false)=>{
    if(!value)return null;
    const parsed=Number(String(value[0]).replace(',','.'));
    return Number.isFinite(parsed)&&parsed>=min&&parsed<=max&&(decimals||Number.isInteger(parsed))?parsed:null;
  };
  let systolic=number(bpValues?.[0],60,300);
  let diastolic=number(bpValues?.[1],30,200);
  if(systolic!==null&&diastolic!==null&&systolic<=diastolic){systolic=null;diastolic=null;}
  return {date:date||null,time:time||null,systolic,diastolic,pulse:number(pulseValue,25,220),weight:number(weightValue,50,500,true),temperature:number(temperatureValue,80,110,true)};
}

function formatScanValue(name,value){
  if(value===null||value===undefined)return 'Not found';
  if(name==='date')return value;
  if(name==='time')return value;
  if(name==='bloodPressure')return value.systolic+'/'+value.diastolic+' mm Hg';
  if(name==='pulse')return value+' bpm';
  if(name==='weight')return value+' lb';
  if(name==='temperature')return value+' °F';
  return String(value);
}

function applyScanFindings(found){
  const fields=[
    ['date','Visit date','date'],
    ['time','Visit time','time'],
    ['bloodPressure','Blood pressure',null],
    ['pulse','Pulse','pulse'],
    ['weight','Weight','weight'],
    ['temperature','Temperature','temperature']
  ];
  const values={
    date:found.date,
    time:found.time,
    bloodPressure:found.systolic!==null&&found.diastolic!==null?found:null,
    pulse:found.pulse,
    weight:found.weight,
    temperature:found.temperature
  };
  const targets={
    date:'date',time:'time',pulse:'pulse',weight:'weight',temperature:'temperature'
  };
  let inserted=0;
  scanFindings.replaceChildren();
  for(const [key,label,field] of fields){
    const value=values[key];
    const item=document.createElement('li');
    if(value===null){
      item.textContent=label+': not detected';
    }else if(field){
      const input=form.elements[targets[key]];
      if(!input.value){
        input.value=value;
        inserted++;
        item.textContent=label+': '+formatScanValue(key,value)+' · added to the form';
      }else if(input.value===String(value)){
        item.textContent=label+': '+formatScanValue(key,value)+' · matches the form';
      }else{
        item.textContent=label+': screenshot shows '+formatScanValue(key,value)+'; form has '+input.value+' · kept the existing form value';
      }
    }else{
      const systolic=form.elements.systolic,diastolic=form.elements.diastolic;
      const existing=systolic.value||diastolic.value;
      if(!existing){
        systolic.value=value.systolic;
        diastolic.value=value.diastolic;
        inserted+=2;
        item.textContent=label+': '+formatScanValue(key,value)+' · added to the form';
      }else if(systolic.value===String(value.systolic)&&diastolic.value===String(value.diastolic)){
        item.textContent=label+': '+formatScanValue(key,value)+' · matches the form';
      }else{
        item.textContent=label+': screenshot shows '+formatScanValue(key,value)+'; form has '+(systolic.value||'—')+'/'+(diastolic.value||'—')+' · kept the existing form values';
      }
    }
    scanFindings.append(item);
  }
  scanResults.hidden=false;
  return inserted;
}

scanOcrCopyButton?.addEventListener('click',async()=>{
  try{
    await navigator.clipboard.writeText(scanOcrText.textContent||'');
    scanOcrCopyStatus.textContent='Copied. Paste the detected text into your message.';
  }catch{
    scanOcrCopyStatus.textContent='Automatic copy was blocked. Press and hold the text to select and copy it.';
  }
});
scanReadButton.addEventListener('click',async()=>{
  const file=scanSelectedFile;
  if(!file)return;
  scanReadButton.disabled=true;
  scanStatus.textContent='Loading the on-device OCR engine…';
  scanResults.hidden=true;
  let worker;
  try{
    const Tesseract=await loadTesseract();
    worker=await Tesseract.createWorker('eng',1,{
      workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.0.0',
      langPath:'https://tessdata.projectnaptha.com/4.0.0',
      logger:progress=>{
        if(progress.status==='loading tesseract core')scanStatus.textContent='Preparing the on-device text reader…';
        else if(progress.status==='loading language traineddata')scanStatus.textContent='Downloading the English text model…';
        else if(progress.status==='recognizing text')scanStatus.textContent='Reading screenshot… '+Math.round((progress.progress||0)*100)+'%';
      }
    });
    const ocrFile=await prepareScanImage(file);
    await worker.setParameters({tessedit_pageseg_mode:'11'});
    const firstPass=await worker.recognize(ocrFile);
    const ocrPassages=['Full image · sparse text layout\n'+(firstPass.data.text||'')];
    let found=parseDonationScreenshot(firstPass.data.text||'');
    let confidence=firstPass.data.confidence||0;
    if(scanFieldCount(found)<7){
      scanStatus.textContent='Checking screenshot layout for missed readings…';
      await worker.setParameters({tessedit_pageseg_mode:'6'});
      const secondPass=await worker.recognize(ocrFile);
      ocrPassages.push('Full image · block layout\n'+(secondPass.data.text||''));
      found=mergeScanFindings(found,parseDonationScreenshot(secondPass.data.text||''));
      confidence=Math.max(confidence,secondPass.data.confidence||0);
    }
    if(!found.date||!found.time){
      scanStatus.textContent='Reading the visit date and time area…';
      const topCrop=await cropScanImage(ocrFile,0.04,0.40);
      if(topCrop){
        await worker.setParameters({tessedit_pageseg_mode:'11'});
        const topPass=await worker.recognize(topCrop);
        ocrPassages.push('Date/time crop · sparse text layout\n'+(topPass.data.text||''));
        found=mergeScanFindings(found,parseDonationScreenshot(topPass.data.text||''));
        confidence=Math.max(confidence,topPass.data.confidence||0);
      }
    }
    if(found.systolic===null||found.diastolic===null||found.weight===null){
      scanStatus.textContent='Reading the health measurements area…';
      const healthCrop=await cropScanImage(ocrFile,0.42,0.50);
      if(healthCrop){
        await worker.setParameters({tessedit_pageseg_mode:'11'});
        const healthPass=await worker.recognize(healthCrop);
        ocrPassages.push('Health readings crop · sparse text layout\n'+(healthPass.data.text||''));
        found=mergeScanFindings(found,parseDonationScreenshot(healthPass.data.text||''));
        confidence=Math.max(confidence,healthPass.data.confidence||0);
      }
    }
    scanOcrText.textContent=ocrPassages.join('\n\n---\n\n');
    scanOcrDetails.hidden=false;
    const inserted=applyScanFindings(found);
    scanWasRead=true;
    saveLocalCslDraft('scan');
    renderWorkflow();
    const count=[found.date,found.time,found.systolic!==null&&found.diastolic!==null?true:null,found.pulse,found.weight,found.temperature].filter(value=>value!==null&&value!==undefined).length;
    if(!count)scanStatus.textContent='No labeled readings were recognized. Keep the preview open and enter the values manually.';
    else scanStatus.textContent='Found '+count+' possible item'+(count===1?'':'s')+'; '+inserted+' blank form field'+(inserted===1?' was':'s were')+' filled. Check the screenshot and every form value before saving.';
    if(confidence<65&&count)scanStatus.textContent+=' OCR confidence was low, so review especially carefully.';
  }catch(error){
    scanStatus.textContent=error?.message||'Could not read this screenshot. You can still use the preview and enter values manually.';
  }finally{
    if(worker)await worker.terminate().catch(()=>{});
    scanReadButton.disabled=false;
  }
});
window.addEventListener('pagehide',()=>{if(scanPreviewUrl)URL.revokeObjectURL(scanPreviewUrl);});

// Initialize only after all DOM references, including the screenshot scanner, are ready.
resetForm();
render();
void restorePendingQr().then(restoredQr=>{if(!restoredQr)void restoreCslDraft();});
