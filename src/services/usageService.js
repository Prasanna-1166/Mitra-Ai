// Talks to the chat-ticket Edge Function: usage status and relay tickets.
// Guests are identified by an opaque random token kept in localStorage; it is not
// a credential for any account. Signed-in users send their session JWT.

const GUEST_TOKEN_KEY = 'mitra-ai:guest-token';

function readGuestToken(storage) {
  try {
    return storage?.getItem(GUEST_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function createTicketClient({ ticketUrl, publishableKey, getAccessToken, storage, fetchImpl }) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));

  async function call(purpose) {
    const headers = { 'Content-Type': 'application/json', apikey: publishableKey };
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else {
      const guest = readGuestToken(storage);
      if (guest) headers['x-guest-token'] = guest;
    }
    let response;
    try {
      response = await doFetch(ticketUrl, { method: 'POST', headers, body: JSON.stringify({ purpose }) });
    } catch {
      const err = new Error('network');
      err.code = 'connect_failed';
      throw err;
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const err = new Error(body?.code ?? 'ticket_failed');
      err.code = body?.code === 'invalid_session' ? 'invalid_session'
        : body?.code === 'rate_limited' ? 'rate_limited' : 'connect_failed';
      throw err;
    }
    if (body?.guestToken) {
      try {
        storage?.setItem(GUEST_TOKEN_KEY, body.guestToken);
      } catch {
        /* storage blocked: the guest session just will not persist */
      }
    }
    return body;
  }

  return {
    status: () => call('status'),
    async getTicket() {
      const body = await call('ticket');
      if (!body?.ticket) {
        const err = new Error('no ticket');
        err.code = 'connect_failed';
        throw err;
      }
      return body.ticket;
    },
  };
}
