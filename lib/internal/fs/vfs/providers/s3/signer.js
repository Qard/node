'use strict';

const crypto = require('crypto');

/**
 * AWS Signature Version 4 signer
 * https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
 */
class AWSSigner {
  constructor(accessKey, secretKey, region) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.region = region;
  }

  /**
   * Sign an HTTP request with AWS Signature V4
   * @param {Object} request - Request object { method, path, headers, query, body }
   * @param {string} service - AWS service name (default: 's3')
   * @returns {Object} Signed headers
   */
  sign(request, service = 's3') {
    const now = new Date();
    const amzDate = this._formatDateTime(now);
    const dateStamp = this._formatDate(now);

    // Add required headers
    const headers = { ...request.headers };
    headers['X-Amz-Date'] = amzDate;

    // Calculate payload hash
    const payload = request.body || '';
    const payloadHash = this._sha256Hex(payload);
    headers['X-Amz-Content-Sha256'] = payloadHash;

    // Step 1: Create canonical request
    const canonicalRequest = this._createCanonicalRequest(
      request.method,
      request.path,
      request.query || '',
      headers,
      payloadHash,
    );

    // Step 2: Create string to sign
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = this._createStringToSign(amzDate, credentialScope, canonicalRequest);

    // Step 3: Calculate signature
    const signingKey = this._getSignatureKey(dateStamp, this.region, service);
    const signature = this._hmacSha256Hex(signingKey, stringToSign);

    // Step 4: Add authorization header
    const signedHeaders = this._getSignedHeaders(headers);
    headers['Authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
  }

  _createCanonicalRequest(method, path, query, headers, payloadHash) {
    const canonicalUri = this._canonicalUri(path);
    const canonicalQuery = this._canonicalQueryString(query);
    const canonicalHeaders = this._canonicalHeaders(headers);
    const signedHeaders = this._getSignedHeaders(headers);

    return [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
  }

  _createStringToSign(amzDate, credentialScope, canonicalRequest) {
    const hashedCanonicalRequest = this._sha256Hex(canonicalRequest);
    return [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashedCanonicalRequest,
    ].join('\n');
  }

  _canonicalUri(path) {
    // URI encode each path segment
    if (!path || path === '/') return '/';

    return path.split('/').map((segment) => {
      return encodeURIComponent(segment).replace(/%2F/g, '/');
    }).join('/');
  }

  _canonicalQueryString(query) {
    if (!query) return '';

    // Parse query string
    const params = new URLSearchParams(query);
    const sorted = Array.from(params.entries()).sort((a, b) => {
      return a[0].localeCompare(b[0]);
    });

    return sorted.map(([key, value]) => {
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }).join('&');
  }

  _canonicalHeaders(headers) {
    // Get all headers, lowercase names, sort by name
    const entries = Object.entries(headers).map(([name, value]) => {
      return [name.toLowerCase(), String(value).trim()];
    });

    entries.sort((a, b) => a[0].localeCompare(b[0]));

    return entries.map(([name, value]) => `${name}:${value}\n`).join('');
  }

  _getSignedHeaders(headers) {
    // Get all header names, lowercase, sort
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    names.sort();
    return names.join(';');
  }

  _getSignatureKey(dateStamp, region, service) {
    const kDate = this._hmacSha256(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = this._hmacSha256(kDate, region);
    const kService = this._hmacSha256(kRegion, service);
    const kSigning = this._hmacSha256(kService, 'aws4_request');
    return kSigning;
  }

  _formatDateTime(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  _formatDate(date) {
    return date.toISOString().substr(0, 10).replace(/-/g, '');
  }

  _sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  _hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  _hmacSha256Hex(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }
}

module.exports = { AWSSigner };
