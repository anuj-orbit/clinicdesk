import { api, requireRole, setStatus, el, fmtTime, errorMessage } from '/js/api.js';

function bookingQuery() {
  const params = new URLSearchParams();
  const status = document.getElementById('filter-status').value;
  const doctorId = document.getElementById('filter-doctor').value;
  if (status) params.set('status', status);
  if (doctorId) params.set('doctorId', doctorId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function loadBookings() {
  const tbody = document.getElementById('all-bookings-body');
  tbody.textContent = '';
  try {
    const data = await api.get(`/api/admin/bookings${bookingQuery()}`);
    const bookings = data.bookings || [];
    if (bookings.length === 0) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: 'No bookings', colspan: '6' }));
      tbody.appendChild(tr);
      return;
    }
    for (const booking of bookings) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: String(booking.id) }));
      tr.appendChild(el('td', { text: booking.doctorName }));
      tr.appendChild(el('td', { text: booking.patientName }));
      tr.appendChild(el('td', { text: fmtTime(booking.start) }));
      tr.appendChild(el('td', { text: booking.status }));

      const actionCell = el('td');
      if (booking.status === 'booked') {
        const cancelBtn = el('button', { class: 'btn btn-danger', type: 'button', text: 'Cancel' });
        cancelBtn.addEventListener('click', () => cancelBooking(booking.id));
        actionCell.appendChild(cancelBtn);
      }
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
    await loadAudit();
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function loadAudit() {
  const tbody = document.getElementById('audit-log-body');
  tbody.textContent = '';
  const params = new URLSearchParams();
  params.set('limit', '100');
  const bookingId = document.getElementById('filter-booking-id').value;
  if (bookingId) params.set('bookingId', bookingId);
  try {
    const data = await api.get(`/api/admin/audit?${params.toString()}`);
    const entries = data.entries || [];
    if (entries.length === 0) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: 'No audit entries', colspan: '4' }));
      tbody.appendChild(tr);
      return;
    }
    for (const entry of entries) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: entry.at ? fmtTime(entry.at) : '' }));
      tr.appendChild(el('td', { text: entry.type || entry.action || entry.event || '' }));
      tr.appendChild(el('td', {
        text: entry.bookingId !== undefined && entry.bookingId !== null ? String(entry.bookingId) : '',
      }));

      const rest = { ...entry };
      delete rest.at;
      delete rest.type;
      delete rest.action;
      delete rest.event;
      delete rest.bookingId;
      tr.appendChild(el('td', { text: JSON.stringify(rest) }));

      tbody.appendChild(tr);
    }
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function loadDoctors() {
  const select = document.getElementById('filter-doctor');
  const previous = select.value;
  select.textContent = '';
  select.appendChild(el('option', { value: '', text: 'All doctors' }));
  try {
    const data = await api.get('/api/admin/users?role=doctor');
    const users = data.users || [];
    for (const user of users) {
      select.appendChild(el('option', { value: String(user.id), text: user.name }));
    }
    if (previous) select.value = previous;
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

async function submitDoctor(event) {
  event.preventDefault();
  const name = document.getElementById('doctor-name').value;
  const email = document.getElementById('doctor-email').value;
  const password = document.getElementById('doctor-password').value;
  const specialty = document.getElementById('doctor-specialty').value;
  const body = { name, email, password };
  if (specialty) body.specialty = specialty;
  try {
    await api.post('/api/admin/doctors', body);
    setStatus('Doctor created', 'ok');
    event.target.reset();
    await loadDoctors();
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
}

(async function init() {
  let user;
  try {
    user = await requireRole('admin')();
  } catch {
    return;
  }
  if (!user) return;

  document.getElementById('filter-status').addEventListener('change', loadBookings);
  document.getElementById('filter-doctor').addEventListener('change', loadBookings);
  document.getElementById('filter-booking-id').addEventListener('change', loadAudit);
  document.getElementById('doctor-form').addEventListener('submit', submitDoctor);

  await loadDoctors();
  await loadBookings();
  await loadAudit();
})();
