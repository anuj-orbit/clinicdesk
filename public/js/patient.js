import { api, requireRole, setStatus, el, fmtTime, errorMessage } from './api.js';

const doctorSelect = document.getElementById('doctor-select');
const fromDateInput = document.getElementById('from-date');
const slotsContainer = document.getElementById('slots');
const bookingsTable = document.getElementById('my-bookings');

let currentDoctorId = null;

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadDoctors() {
  try {
    const res = await api.get('/api/doctors');
    const doctors = res.doctors || [];
    doctorSelect.textContent = '';
    doctorSelect.appendChild(el('option', { value: '' }, 'Select a doctor'));
    for (const doc of doctors) {
      const label = doc.specialty ? `${doc.name} - ${doc.specialty}` : doc.name;
      doctorSelect.appendChild(el('option', { value: String(doc.id) }, label));
    }
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function loadSlots() {
  slotsContainer.textContent = '';
  if (!currentDoctorId) return;

  const from = fromDateInput.value || todayStr();
  try {
    const res = await api.get(
      `/api/doctors/${encodeURIComponent(currentDoctorId)}/slots?from=${encodeURIComponent(from)}&days=7`
    );
    renderSlots(res.slots || []);
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

function renderSlots(slots) {
  slotsContainer.textContent = '';
  if (slots.length === 0) {
    slotsContainer.appendChild(el('p', { class: 'muted' }, 'No available slots.'));
    return;
  }

  // Group by calendar date (clinic-local date part of the ISO string).
  const groups = new Map();
  for (const slot of slots) {
    const dateKey = slot.start.slice(0, 10);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(slot);
  }

  for (const [dateKey, daySlots] of groups) {
    const group = el('div', { class: 'slot-date' });
    group.appendChild(el('h3', {}, dateKey));
    const grid = el('div', { class: 'slots-grid' });
    for (const slot of daySlots) {
      const btn = el(
        'button',
        { class: 'slot btn btn-primary', type: 'button', 'data-start': slot.start },
        fmtTime(slot.start)
      );
      btn.addEventListener('click', () => bookSlot(slot.start, btn));
      grid.appendChild(btn);
    }
    group.appendChild(grid);
    slotsContainer.appendChild(group);
  }
}

async function bookSlot(start, btn) {
  btn.disabled = true;
  try {
    await api.post('/api/bookings', { doctorId: Number(currentDoctorId), start });
    setStatus('Booked', 'ok');
    await refresh();
  } catch (err) {
    if (err.code === 'slot_taken') {
      setStatus('That slot was just taken', 'error');
      await loadSlots();
    } else {
      setStatus(errorMessage(err), 'error');
      btn.disabled = false;
    }
  }
}

async function loadBookings() {
  const tbody = bookingsTable.querySelector('tbody');
  tbody.textContent = '';
  try {
    const res = await api.get('/api/bookings/mine');
    const bookings = res.bookings || [];
    if (bookings.length === 0) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No bookings yet')));
      return;
    }
    for (const b of bookings) {
      const row = el('tr');
      row.appendChild(el('td', {}, b.doctorName));
      row.appendChild(el('td', {}, fmtTime(b.start)));
      row.appendChild(el('td', {}, b.status));
      const actionCell = el('td');
      if (b.status === 'booked') {
        const cancelBtn = el('button', { class: 'btn btn-danger', type: 'button' }, 'Cancel');
        cancelBtn.addEventListener('click', () => cancelBooking(b.id, cancelBtn));
        actionCell.appendChild(cancelBtn);
      }
      row.appendChild(actionCell);
      tbody.appendChild(row);
    }
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function cancelBooking(id, btn) {
  btn.disabled = true;
  try {
    await api.post(`/api/bookings/${encodeURIComponent(id)}/cancel`, {});
    setStatus('Cancelled', 'ok');
    await refresh();
  } catch (err) {
    setStatus(errorMessage(err), 'error');
    btn.disabled = false;
  }
}

async function refresh() {
  await loadSlots();
  await loadBookings();
}

doctorSelect.addEventListener('change', () => {
  currentDoctorId = doctorSelect.value || null;
  loadSlots();
});

fromDateInput.addEventListener('change', loadSlots);

async function init() {
  const user = await requireRole('patient');
  if (!user) return;

  fromDateInput.value = todayStr();
  await loadDoctors();
  await loadBookings();
}

init();
