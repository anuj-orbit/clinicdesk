export const api = {
  async get(path) {
    const res = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw { status: res.status, code: 'http_error', message: res.statusText };
    }
    const text = await res.text();
    if (!text) {
      throw { status: res.status, code: 'network', message: 'Empty response' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw { status: res.status, code: 'network', message: 'Invalid JSON' };
    }
    if (res.status >= 400) {
      if (data.error) {
        throw { status: res.status, code: data.error.code, message: data.error.message };
      }
      throw { status: res.status, code: 'http_error', message: data.message || res.statusText };
    }
    return data;
  },

  async post(path, body = {}) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw { status: res.status, code: 'http_error', message: res.statusText };
    }
    const text = await res.text();
    if (!text && res.status >= 400) {
      throw { status: res.status, code: 'network', message: 'Empty error response' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (res.status >= 400) {
        throw { status: res.status, code: 'network', message: 'Invalid error JSON' };
      }
      throw e;
    }
    if (res.status >= 400) {
      if (data.error) {
        throw { status: res.status, code: data.error.code, message: data.error.message };
      }
      throw { status: res.status, code: 'http_error', message: data.message || res.statusText };
    }
    return data;
  },

  async put(path, body = {}) {
    const res = await fetch(path, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw { status: res.status, code: 'http_error', message: res.statusText };
    }
    const text = await res.text();
    if (!text && res.status >= 400) {
      throw { status: res.status, code: 'network', message: 'Empty error response' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (res.status >= 400) {
        throw { status: res.status, code: 'network', message: 'Invalid error JSON' };
      }
      throw e;
    }
    if (res.status >= 400) {
      if (data.error) {
        throw { status: res.status, code: data.error.code, message: data.error.message };
      }
      throw { status: res.status, code: 'http_error', message: data.message || res.statusText };
    }
    return data;
  },

  async del(path) {
    const res = await fetch(path, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw { status: res.status, code: 'http_error', message: res.statusText };
    }
    const text = await res.text();
    if (!text && res.status >= 400) {
      throw { status: res.status, code: 'network', message: 'Empty error response' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (res.status >= 400) {
        throw { status: res.status, code: 'network', message: 'Invalid error JSON' };
      }
      throw e;
    }
    if (res.status >= 400) {
      if (data.error) {
        throw { status: res.status, code: data.error.code, message: data.error.message };
      }
      throw { status: res.status, code: 'http_error', message: data.message || res.statusText };
    }
    return data;
  },
};

export async function requireRole(role) {
  let session;
  try {
    session = await api.get('/api/auth/session');
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/';
      return null;
    }
    throw err;
  }

  if (!session || !session.user) {
    window.location.href = '/';
    return null;
  }

  if (session.user.role !== role) {
    window.location.href = `/${session.user.role}.html`;
    return null;
  }

  const nameEl = document.getElementById('user-name');
  if (nameEl) nameEl.textContent = session.user.name;

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  }

  return session.user;
}

export async function logout() {
  await api.post('/api/auth/logout');
  window.location.href = '/';
}

export function setStatus(msg, kind) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;

  statusEl.className = 'status';
  if (kind === 'ok') statusEl.classList.add('status-ok');
  if (kind === 'error') statusEl.classList.add('status-error');
  statusEl.textContent = msg;
}

export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);

  if (attrs.class) element.className = attrs.class;
  if (attrs.id) element.id = attrs.id;
  if (attrs.text != null) element.textContent = attrs.text;

  // Attribute sources: a nested `attrs` object, plus any other top-level keys.
  const extra = { ...(attrs.attrs || {}) };
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class' || key === 'id' || key === 'text' || key === 'attrs') continue;
    extra[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === false || value == null) continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children) {
    if (child == null || child === false) continue;
    if (child instanceof Node) {
      element.appendChild(child);
    } else {
      element.appendChild(document.createTextNode(String(child)));
    }
  }

  return element;
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function errorMessage(err) {
  const code = err.code || 'unknown';
  const messages = {
    slot_taken: 'That slot was just taken',
    patient_busy: 'You already have a booking at that time',
    slot_in_past: 'Cannot book a past slot',
    too_far_ahead: 'Slot is too far in the future (max 90 days)',
    outside_availability: 'Doctor not available at that time',
    misaligned_slot: 'Slot must be on a :00/:30 boundary',
    already_cancelled: 'Booking already cancelled',
    booking_in_past: 'Cannot cancel a past booking',
    availability_overlap: 'Availability overlaps with existing rule',
    email_taken: 'That email is already registered',
    invalid_credentials: 'Invalid email or password',
    unauthenticated: 'Please log in',
    forbidden: 'You do not have permission',
    doctor_not_found: 'Doctor not found',
    validation: 'Invalid data provided',
  };
  return messages[code] || err.message || 'An error occurred';
}