// Dependency-free client. All dynamic content is written with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
const status = (msg, isError = false) => {
  $('status').textContent = msg;
  $('status').className = isError ? 'error' : '';
};

let config;
let idToken = sessionStorage.getItem('idToken') ?? '';
let pendingEmail = '';

async function cognito(target, body) {
  const res = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify({ ClientId: config.userPoolClientId, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? data.__type ?? `Cognito error ${res.status}`);
  return data;
}

async function api(method, path, body) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${idToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    signOut();
    throw new Error('Session expired. Please sign in again.');
  }
  if (res.status === 204) return undefined;
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.errors?.join(', ') ?? data.message ?? `Request failed (${res.status})`);
  }
  return data;
}

function signOut() {
  idToken = '';
  sessionStorage.removeItem('idToken');
  show('auth');
}

function show(view) {
  $('auth').hidden = view !== 'auth';
  $('app').hidden = view !== 'app';
  if (view === 'app') renderEntities();
}

const routeFor = (e) => `${e.name.toLowerCase()}s`;

function renderEntities() {
  const root = $('entities');
  root.replaceChildren();
  for (const entity of config.entities) {
    const box = document.createElement('div');
    box.className = 'entity';
    const h = document.createElement('h2');
    h.textContent = entity.name;
    const list = document.createElement('ul');
    const form = document.createElement('form');
    for (const f of entity.fields) {
      const label = document.createElement('label');
      label.append(`${f.name}${f.required ? ' *' : ''}`);
      const input = document.createElement('input');
      input.name = f.name;
      input.required = f.required && f.type !== 'boolean';
      input.type = f.type === 'number' ? 'number' : f.type === 'boolean' ? 'checkbox' : 'text';
      if (f.type === 'number') input.step = 'any';
      label.append(input);
      form.append(label);
    }
    const add = document.createElement('button');
    add.type = 'submit';
    add.textContent = `Add ${entity.name}`;
    form.append(add);

    const refresh = async () => {
      const { items } = await api('GET', `/${routeFor(entity)}`);
      list.replaceChildren();
      for (const item of items) {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = entity.fields.map((f) => `${f.name}: ${item[f.name] ?? ''}`).join(' · ');
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          try {
            await api('DELETE', `/${routeFor(entity)}/${encodeURIComponent(item.id)}`);
            await refresh();
          } catch (e) {
            status(e.message, true);
          }
        });
        li.append(text, del);
        list.append(li);
      }
    };

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = {};
      for (const f of entity.fields) {
        const el = form.elements[f.name];
        if (f.type === 'boolean') data[f.name] = el.checked;
        else if (el.value !== '') data[f.name] = f.type === 'number' ? Number(el.value) : el.value;
      }
      try {
        await api('POST', `/${routeFor(entity)}`, data);
        form.reset();
        status('Saved.');
        await refresh();
      } catch (e) {
        status(e.message, true);
      }
    });

    box.append(h, form, list);
    root.append(box);
    refresh().catch((e) => status(e.message, true));
  }
}

function wire() {
  $('show-signup').addEventListener('click', () => {
    $('signin').hidden = true;
    $('signup').hidden = false;
  });
  $('signout').addEventListener('click', signOut);

  $('signin').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      const r = await cognito('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: f.email.value, PASSWORD: f.password.value },
      });
      // The API's JWT authorizer validates the audience, which only the ID token carries.
      idToken = r.AuthenticationResult.IdToken;
      sessionStorage.setItem('idToken', idToken);
      status('');
      show('app');
    } catch (e) {
      status(e.message, true);
    }
  });

  $('signup').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      await cognito('SignUp', {
        Username: f.email.value,
        Password: f.password.value,
        UserAttributes: [{ Name: 'email', Value: f.email.value }],
      });
      pendingEmail = f.email.value;
      $('signup').hidden = true;
      $('confirm').hidden = false;
      status('Check your email for the confirmation code.');
    } catch (e) {
      status(e.message, true);
    }
  });

  $('confirm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await cognito('ConfirmSignUp', {
        Username: pendingEmail,
        ConfirmationCode: ev.target.elements.code.value,
      });
      $('confirm').hidden = true;
      $('signin').hidden = false;
      status('Confirmed. You can sign in now.');
    } catch (e) {
      status(e.message, true);
    }
  });
}

try {
  const res = await fetch('config.json');
  if (!res.ok) throw new Error(`config.json ${res.status}`);
  config = await res.json();
  document.title = config.name;
  $('title').textContent = config.name;
  wire();
  show(idToken ? 'app' : 'auth');
} catch (e) {
  status(`Could not load configuration: ${e.message}`, true);
}
