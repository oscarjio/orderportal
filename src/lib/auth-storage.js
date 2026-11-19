/*
 * auth-storage.js
 * ---------------------------------------------------------------
 * Enkel, säker lagring av HTTP Digest-state för OrderPortal.
 *
 * Använder Electrons `app.getPath('userData')` som mapp och
 * `safeStorage.encryptString` för kryptering om den är tillgänglig
 * (dvs. när OS:et stödjer det och appen redan är 'ready'). Annars
 * skrivs innehållet som plaintext JSON med en varning i konsolen.
 *
 * Exporterar: loadState(), saveState(state), clearState()
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILE_NAME = 'digest-auth.json';
// Prefix som markerar att filen innehåller krypterad base64-data.
const ENCRYPTED_PREFIX = 'enc:v1:';

function getFilePath() {
  const dir = app.getPath('userData');
  return path.join(dir, FILE_NAME);
}

function canEncrypt() {
  try {
    return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable());
  } catch (err) {
    return false;
  }
}

function warnPlaintext(reason) {
  // eslint-disable-next-line no-console
  console.warn(
    '[auth-storage] safeStorage är inte tillgängligt (' + reason + '). '
    + 'digest-auth.json skrivs som PLAINTEXT.'
  );
}

/**
 * Läs in digest-state. Returnerar `null` om inget finns eller
 * filen inte kunde avkodas.
 */
function loadState() {
  const file = getFilePath();

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // eslint-disable-next-line no-console
    console.error('[auth-storage] Kunde inte läsa ' + file + ':', err);
    return null;
  }

  if (!raw) return null;

  try {
    if (raw.startsWith(ENCRYPTED_PREFIX)) {
      if (!canEncrypt()) {
        // eslint-disable-next-line no-console
        console.error('[auth-storage] Filen är krypterad men safeStorage är otillgängligt.');
        return null;
      }
      const buf = Buffer.from(raw.slice(ENCRYPTED_PREFIX.length), 'base64');
      const decrypted = safeStorage.decryptString(buf);
      return JSON.parse(decrypted);
    }
    // Plaintext-fallback
    return JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth-storage] Kunde inte avkoda digest-state:', err);
    return null;
  }
}

/**
 * Spara digest-state. Krypterar med safeStorage om möjligt.
 * Returnerar `true` vid success.
 */
function saveState(state) {
  if (state == null || typeof state !== 'object') {
    throw new TypeError('saveState kräver ett objekt.');
  }

  const file = getFilePath();
  const json = JSON.stringify(state, null, 2);

  let payload;
  if (canEncrypt()) {
    try {
      const buf = safeStorage.encryptString(json);
      payload = ENCRYPTED_PREFIX + buf.toString('base64');
    } catch (err) {
      warnPlaintext('kryptering kastade: ' + (err && err.message));
      payload = json;
    }
  } else {
    warnPlaintext('isEncryptionAvailable() === false');
    payload = json;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth-storage] Kunde inte skriva ' + file + ':', err);
    return false;
  }
}

/**
 * Radera digest-state. Icke-existerande fil räknas som success.
 */
function clearState() {
  const file = getFilePath();
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    // eslint-disable-next-line no-console
    console.error('[auth-storage] Kunde inte radera ' + file + ':', err);
    return false;
  }
}

module.exports = {
  loadState,
  saveState,
  clearState,
};
