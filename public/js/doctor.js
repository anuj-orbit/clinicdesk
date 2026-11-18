import { api, requireRole, setStatus, el, fmtTime, errorMessage } from '/js/api.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let editingId = null;

function minutesToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fillTimeSelect(select, fromMin, toMin) {
  select.textContent = '';
  for (let m = fromMin; m <= toMin; m += 30) {
    const value = minutesToHHMM(m);
    select.appendChild(el('option', { value, text: value }));
  }
}

function resetForm() {
  editingId = null;
  document.getElementById('availability-day').value = '0';
  document.getElementById('availability-start').value = '09:00';
  document.getElementById('availability-end').value = '17:00';
  document.getElementById('availability-form-title').textContent = 'Add Availability';
  document.getElementById('availability-submit').textContent = 'Add';
  document.getElementById('availability-cancel').hidden = true;
}

async function loadRules() {
  const list = document.getElementById('availability-list');
  list.textContent = '';
  try {
    const data = await api.get('/api/doctor/availability');
    const rules = data.rules || [];
    if (rules.length === 0) {
      list.appendChild(el('p', { class: 'muted', text: 'No availability rules yet.' }));
      return;
    }
    for (const rule of rules) {
      const row = el('div', { class: 'form-row' });
      const label = el('span', {
        text: `${DAY_NAMES[rule.dayOfWeek]} ${rule.startTime}-${rule.endTime}`,
      });
      row.appendChild(label);

      const editBtn = el('button', { class: 'btn', type: 'button', text: 'Edit' });
      editBtn.addEventListener('click', () => startEdit(rule));
      row.appendChild(editBtn);

      const delBtn = el('button', { class: 'btn btn-danger', type: 'button', text: 'Delete' });
      delBtn.addEventListener('click', () => removeRule(rule));
      row.appendChild(delBtn);

      list.appendChild(row);
    }
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

function startEdit(rule) {
  editingId = rule.id;
  document.getElementById('availability-day').value = String(rule.dayOfWeek);
  document.getElementById('availability-start').value = rule.startTime;
  document.getElementById('availability-end').value = rule.endTime;
  document.getElementById('availability-form-title').textContent = 'Edit Availability';
  document.getElementById('availability-submit').textContent = 'Save';
  document.getElementById('availability-cancel').hidden = false;
}

async function removeRule(rule) {
  try {
    await api.del(`/api/doctor/availability/${rule.id}`);
    if (editingId === rule.id) resetForm();
    setStatus('Availability removed', 'ok');
    await loadRules();
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function submitAvailability(event) {
  event.preventDefault();
  const body = {
    dayOfWeek: Number(document.getElementById('availability-day').value),
    startTime: document.getElementById('availability-start').value,
    endTime: document.getElementById('availability-end').value,
  };
  try {
    if (editingId === null) {
      await api.post('/api/doctor/availability', body);
      setStatus('Availability added', 'ok');
    } else {
      await api.put(`/api/doctor/availability/${editingId}`, body);
      setStatus('Availability updated', 'ok');
    }
    resetForm();
    await loadRules();
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function loadBookings() {
  const tbody = document.getElementById('doctor-bookings-body');
  tbody.textContent = '';
  const from = new Date().toISOString();
  try {
    const data = await api.get(`/api/doctor/bookings?from=${encodeURIComponent(from)}&status=booked`);
    const bookings = data.bookings || [];
    if (bookings.length === 0) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: 'No upcoming bookings', colspan: '3' }));
      tbody.appendChild(tr);
      return;
    }
    for (const booking of bookings) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: booking.patientName }));
      tr.appendChild(el('td', { text: fmtTime(booking.start) }));

      const actionCell = el('td');
      const cancelBtn = el('button', { class: 'btn btn-danger', type: 'button', text: 'Cancel' });
      cancelBtn.addEventListener('click', () => cancelBooking(booking.id));
      actionCell.appendChild(cancelBtn);
      tr.appendChild(actionCell);

      tbody.appendChild(tr);
    }
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function cancelBooking(id) {
  try {
    await api.post(`/api/bookings/${id}/cancel`, {});
    setStatus('Booking cancelled', 'ok');
    await loadBookings();
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

(async function init() {
  let user;
  try {
    user = await requireRole('doctor')();
  } catch {
    return;
  }
  if (!user) return;

  fillTimeSelect(document.getElementById('availability-start'), 0, 1410);
  fillTimeSelect(document.getElementById('availability-end'), 30, 1440);
  resetForm();

  document.getElementById('availability-form').addEventListener('submit', submitAvailability);
  document.getElementById('availability-cancel').addEventListener('click', resetForm);

  await loadRules();
  await loadBookings();
})();
