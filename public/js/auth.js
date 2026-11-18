import { api, setStatus, errorMessage } from './api.js';

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

function redirectByRole(user) {
  if (user.role === 'patient') {
    window.location.href = '/patient.html';
  } else if (user.role === 'doctor') {
    window.location.href = '/doctor.html';
  } else if (user.role === 'admin') {
    window.location.href = '/admin.html';
  } else {
    window.location.href = '/';
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await api.post('/api/auth/login', { email, password });
    setStatus('Logged in', 'ok');
    redirectByRole(res.user);
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('register-name').value;
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;

  try {
    const res = await api.post('/api/auth/register', { name, email, password });
    setStatus('Account created', 'ok');
    redirectByRole(res.user);
  } catch (err) {
    setStatus(errorMessage(err), 'error');
  }
});

// If a valid session already exists, skip the login page.
async function checkSession() {
  try {
    const res = await api.get('/api/auth/session');
    if (res && res.user) {
      redirectByRole(res.user);
    }
  } catch (err) {
    // Not logged in — stay on the login page.
  }
}

checkSession();
