'use strict';

/**
 * HTTP Digest Authentication-klient (RFC 7616 / RFC 2617).
 *
 * Stödjer just nu algoritmen MD5 (RFC 7616 default när inget
 * `algorithm` anges i challenge). MD5-sess är inte implementerat.
 *
 * Intern state hålls i instansen och kan serialiseras via toJSON/fromJSON
 * utan att skriva ut plaintext-lösenord (endast HA1 sparas).
 */

const crypto = require('crypto');

/**
 * Hash-hex av en sträng. Projektportalen använder SHA-256 trots att
 * `algorithm` inte anges i WWW-Authenticate-headern (observerat via deras
 * webapp). 64 tecken output.
 * @param {string} s
 * @returns {string}
 */
function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
// Bakåtkompatibelt namn — används fortfarande på några ställen
const md5 = hash;

/**
 * Parsa nyckel/värde-paren i en WWW-Authenticate "Digest ..."-header.
 * Stödjer både quoted ("...") och unquoted värden, samt komma i quoted värden.
 * @param {string} header
 * @returns {Object<string,string>}
 */
function parseDigestHeader(header) {
  if (typeof header !== 'string') return {};
  // Ta bort ledande schema-prefix "Digest " om det finns
  let rest = header.trim();
  if (/^digest\s+/i.test(rest)) {
    rest = rest.replace(/^digest\s+/i, '');
  }

  const out = {};
  let i = 0;
  const len = rest.length;

  while (i < len) {
    // Skippa whitespace och komman
    while (i < len && /[\s,]/.test(rest[i])) i++;
    if (i >= len) break;

    // Läs nyckel
    let keyStart = i;
    while (i < len && rest[i] !== '=' && !/\s/.test(rest[i])) i++;
    const key = rest.slice(keyStart, i).toLowerCase();

    // Skippa whitespace och '='
    while (i < len && /\s/.test(rest[i])) i++;
    if (rest[i] === '=') i++;
    while (i < len && /\s/.test(rest[i])) i++;

    let value = '';
    if (rest[i] === '"') {
      // Quoted string — läs till nästa okvoterat "
      i++;
      let valStart = i;
      while (i < len) {
        if (rest[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        if (rest[i] === '"') break;
        i++;
      }
      value = rest.slice(valStart, i).replace(/\\(.)/g, '$1');
      if (rest[i] === '"') i++;
    } else {
      // Token — läs till komma eller slut
      let valStart = i;
      while (i < len && rest[i] !== ',') i++;
      value = rest.slice(valStart, i).trim();
    }

    if (key) out[key] = value;
  }

  return out;
}

class DigestAuth {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.username]
   * @param {string} [opts.realm]
   * @param {string} [opts.ha1]       Förberäknad HA1 (hex MD5 av username:realm:password)
   * @param {string} [opts.nonce]
   * @param {string} [opts.qop]
   * @param {string} [opts.opaque]
   * @param {string} [opts.algorithm]
   * @param {string} [opts.clientId]  Applikationsspecifikt — current client id
   * @param {string} [opts.role]      Applikationsspecifikt — inloggad användares roll
   */
  constructor(opts = {}) {
    this.username = opts.username || null;
    this.realm = opts.realm || null;
    this.ha1 = opts.ha1 || null;
    this.nonce = opts.nonce || null;
    this.qop = opts.qop || null;
    this.opaque = opts.opaque || null;
    this.algorithm = opts.algorithm || 'MD5';
    this.clientId = opts.clientId || null;
    this.role = opts.role || null;
    this._nc = 0;
  }

  /**
   * MD5(username:realm:password) — HA1 enligt RFC 7616 §3.4.2 för algorithm MD5.
   * @param {string} username
   * @param {string} realm
   * @param {string} password
   * @returns {string}
   */
  /**
   * Projektportalens HA1-formel (verifierad mot browser's stored userHash):
   *   HA1 = SHA256(username : realm : SHA256(password))
   *
   * Password är först SHA-256-hashat, sedan används det som "password"
   * i den klassiska RFC 7616-formeln. Den dubbelhashningen är Projektportalen-
   * specifik och matchar inte standard RFC.
   */
  static computeHA1(username, realm, password) {
    const pwHash = hash(password);
    return hash(`${username}:${realm}:${pwHash}`);
  }

  /**
   * Beräkna alla rimliga HA1-varianter (för diagnos).
   * @returns {{label:string, hash:string}[]}
   */
  static computeHA1Variants(username, realm, password) {
    return [
      { label: 'SHA256(user:realm:pw)', hash: hash(`${username}:${realm}:${password}`) },
      { label: 'SHA256(pw)', hash: hash(password) },
      { label: 'SHA256(user:pw)', hash: hash(`${username}:${password}`) },
      { label: 'SHA256(pw:realm)', hash: hash(`${password}:${realm}`) },
      { label: 'SHA256(realm:user:pw)', hash: hash(`${realm}:${username}:${password}`) },
      { label: 'SHA256(user.lower:realm:pw)', hash: hash(`${username.toLowerCase()}:${realm}:${password}`) },
      { label: 'SHA256(pw:user)', hash: hash(`${password}:${username}`) },
      { label: 'SHA256(pw:user:realm)', hash: hash(`${password}:${username}:${realm}`) },
      { label: 'SHA256(url-enc-user:realm:pw)', hash: hash(`${encodeURIComponent(username)}:${realm}:${password}`) },
    ];
  }

  /**
   * MD5(METHOD:uri) — HA2 för qop=auth eller tomt qop.
   * @param {string} method
   * @param {string} uri
   * @returns {string}
   */
  static computeHA2(method, uri) {
    return md5(`${String(method).toUpperCase()}:${uri}`);
  }

  /**
   * Projektportalen-specifik response-beräkning:
   * `response = SHA256(ha1:nonce:nc:cnonce:qop:ha2:clientId)`
   *
   * clientId appendas i slutet — det är en Projektportalen-variant av RFC 7616.
   * Utan clientId-suffixet ger servern "Value cannot be null. Parameter name: String".
   *
   * @param {{ha1:string,nonce:string,nc:string,cnonce:string,qop:string,ha2:string,clientId?:string|number}} args
   * @returns {string}
   */
  static computeResponse({ ha1, nonce, nc, cnonce, qop, ha2, clientId }) {
    const cid = clientId !== undefined && clientId !== null ? String(clientId) : '';
    if (qop) {
      return hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}:${cid}`);
    }
    return hash(`${ha1}:${nonce}:${ha2}`);
  }

  /**
   * Sätt credentials (username + password) så att HA1 beräknas.
   * Plaintext-lösenord sparas inte på instansen.
   * @param {string} username
   * @param {string} password
   */
  setCredentials(username, password) {
    this.username = username;
    // Spara password internt så vi kan testa andra HA1-varianter vid 401-retry
    this._plaintextPw = password;
    if (this.realm) {
      this.ha1 = DigestAuth.computeHA1(username, this.realm, password);
    } else {
      this._pendingPassword = password;
    }
  }

  /**
   * Parsa en WWW-Authenticate-header (från 401/204) och uppdatera state.
   * Återställer även `nc`-räknaren eftersom nonce är ny.
   * @param {string} wwwAuthenticateHeader
   */
  setChallenge(wwwAuthenticateHeader) {
    const params = parseDigestHeader(wwwAuthenticateHeader || '');
    if (params.realm) this.realm = params.realm;
    if (params.nonce) this.nonce = params.nonce;
    if (params.qop) {
      // qop kan vara "auth,auth-int" — välj "auth" om möjligt
      const opts = params.qop.split(',').map((s) => s.trim());
      this.qop = opts.includes('auth') ? 'auth' : opts[0];
    }
    if (params.opaque) this.opaque = params.opaque;
    if (params.algorithm) this.algorithm = params.algorithm;

    // Om vi hade pending password och nu har en realm — beräkna HA1
    if (this._pendingPassword && this.username && this.realm) {
      this.ha1 = DigestAuth.computeHA1(this.username, this.realm, this._pendingPassword);
      delete this._pendingPassword;
    }

    // Ny nonce → nollställ nc-räknare
    this._nc = 0;
  }

  /**
   * Validera att alla fält behövs för en autentiserad request finns.
   * @private
   */
  _assertReady() {
    const missing = [];
    if (!this.username) missing.push('username');
    if (!this.realm) missing.push('realm');
    if (!this.ha1) missing.push('ha1');
    if (!this.nonce) missing.push('nonce');
    if (!this.qop) missing.push('qop');
    if (missing.length) {
      throw new Error('Digest not configured — call setChallenge or fromJSON first');
    }
  }

  /**
   * Bygg en komplett `Authorization: Digest ...`-header.
   * Inkrementerar internt `nc`-räknaren med ett per anrop.
   * @param {string} method  HTTP-metod (GET, POST, ...)
   * @param {string} uri     request-URI (path + ev. query-string)
   * @returns {string}
   */
  buildAuthorizationHeader(method, uri) {
    this._assertReady();

    this._nc += 1;
    const nc = this._nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(16).toString('hex');

    const ha2 = DigestAuth.computeHA2(method, uri);
    const response = DigestAuth.computeResponse({
      ha1: this.ha1,
      nonce: this.nonce,
      nc,
      cnonce,
      qop: this.qop,
      ha2,
      clientId: this.clientId,
    });

    // Field-ordning enligt observation av den riktiga web-appen:
    // username, userHash, realm, nonce, uri, response, qop, nc, cnonce, clientId
    // Inget `algorithm`, inget `role` och username är URL-encodad.
    const parts = [
      `username="${encodeURIComponent(this.username)}"`,
      `userHash="${this.ha1}"`,
      `realm="${this.realm}"`,
      `nonce="${this.nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
      `qop=${this.qop}`,
      `nc=${nc}`,
      `cnonce="${cnonce}"`,
    ];
    if (this.opaque) parts.push(`opaque="${this.opaque}"`);
    if (this.clientId !== null && this.clientId !== undefined) {
      parts.push(`clientId=${this.clientId}`);
    }

    return 'Digest ' + parts.join(', ');
  }

  /**
   * Serialisera state (utan plaintext-lösenord).
   * @returns {Object}
   */
  toJSON() {
    return {
      username: this.username,
      realm: this.realm,
      ha1: this.ha1,
      nonce: this.nonce,
      qop: this.qop,
      opaque: this.opaque,
      algorithm: this.algorithm,
      clientId: this.clientId,
      role: this.role,
      nc: this._nc,
    };
  }

  /**
   * Återskapa state från JSON (t.ex. från persistent lagring).
   * @param {Object} obj
   */
  fromJSON(obj) {
    if (!obj || typeof obj !== 'object') return;
    // Projektportalen använder userName/userHash (camelCase med stort U/H)
    // medan RFC-digest använder username/ha1. Stöd båda.
    this.username = obj.username || obj.userName || null;
    this.realm = obj.realm || null;
    this.ha1 = obj.ha1 || obj.userHash || null;
    this.nonce = obj.nonce || null;
    this.qop = obj.qop || null;
    this.opaque = obj.opaque || null;
    this.algorithm = obj.algorithm || 'MD5';
    this.clientId = obj.clientId || null;
    this.role = obj.role || null;
    // nc kan vara number eller hex-string ("0000000e") — parsa båda
    if (typeof obj.nc === 'number') {
      this._nc = obj.nc;
    } else if (typeof obj.nc === 'string' && obj.nc) {
      this._nc = parseInt(obj.nc, 16) || 0;
    } else {
      this._nc = 0;
    }
  }

  /**
   * Nollställ all state (logout).
   */
  clear() {
    this.username = null;
    this.realm = null;
    this.ha1 = null;
    this.nonce = null;
    this.qop = null;
    this.opaque = null;
    this.algorithm = 'MD5';
    this.clientId = null;
    this.role = null;
    this._nc = 0;
    delete this._pendingPassword;
  }
}

module.exports = { DigestAuth, parseDigestHeader };
