'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { AWSSigner } = require('internal/fs/vfs/providers/s3/signer');

/**
 * Minimal S3 HTTP client with AWS Signature V4 signing
 * No external dependencies
 */
class S3Client {
  constructor(options) {
    this.bucket = options.bucket;
    this.region = options.region || 'us-east-1';
    this.accessKey = options.accessKey || process.env.AWS_ACCESS_KEY_ID;
    this.secretKey = options.secretKey || process.env.AWS_SECRET_ACCESS_KEY;
    this.endpoint = this._buildEndpoint(options.endpoint);

    if (!this.accessKey || !this.secretKey) {
      throw new Error('Missing AWS credentials');
    }

    this.signer = new AWSSigner(this.accessKey, this.secretKey, this.region);
  }

  _buildEndpoint(customEndpoint) {
    if (customEndpoint) {
      // Custom endpoint (MinIO, DigitalOcean, etc.)
      const url = new URL(customEndpoint);
      if (!url.pathname.includes(this.bucket)) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/${this.bucket}`;
      }
      return url.href.replace(/\/$/, '');
    }

    // AWS S3 - use virtual-hosted-style URLs
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
  }

  /**
   * GET object - full download
   */
  async getObject(key) {
    const path = `/${key}`;
    return await this._request('GET', path);
  }

  /**
   * GET object with Range header for partial reads
   */
  async getObjectRange(key, startByte, endByte) {
    const path = `/${key}`;
    const headers = {
      'Range': `bytes=${startByte}-${endByte}`,
    };
    return await this._request('GET', path, { headers });
  }

  /**
   * HEAD object to get size
   */
  async headObject(key) {
    const path = `/${key}`;
    return await this._request('HEAD', path);
  }

  /**
   * GET object size (returns null if not found)
   */
  async getObjectSize(key) {
    try {
      const response = await this.headObject(key);
      return parseInt(response.headers['content-length'], 10);
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * PUT object - upload content
   */
  async putObject(key, body, options = {}) {
    const path = `/${key}`;
    const headers = {
      'Content-Type': options.contentType || 'application/octet-stream',
    };

    // Add metadata headers
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k}`] = v;
      }
    }

    return await this._request('PUT', path, { headers, body });
  }

  /**
   * DELETE object
   */
  async deleteObject(key) {
    const path = `/${key}`;
    return await this._request('DELETE', path);
  }

  /**
   * COPY object (server-side copy)
   */
  async copyObject(sourceKey, destKey, options = {}) {
    const path = `/${destKey}`;
    const headers = {
      'x-amz-copy-source': `/${this.bucket}/${sourceKey}`,
    };

    // Add metadata headers
    if (options.metadata) {
      headers['x-amz-metadata-directive'] = 'REPLACE';
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k}`] = v;
      }
    }

    return await this._request('PUT', path, { headers });
  }

  /**
   * LIST objects with prefix
   */
  async listObjects(prefix = '', delimiter = null) {
    const query = new URLSearchParams();
    if (prefix) query.set('prefix', prefix);
    if (delimiter) query.set('delimiter', delimiter);

    const path = `/?${query.toString()}`;
    const response = await this._request('GET', path);

    // Parse XML response
    return this._parseListResponse(response.body);
  }

  /**
   * Make HTTP request with AWS signing
   */
  async _request(method, path, options = {}) {
    const url = new URL(`${this.endpoint}${path}`);
    const headers = {
      'Host': url.host,
      ...(options.headers || {}),
    };

    // Sign the request
    const signedHeaders = this.signer.sign({
      method,
      path: url.pathname + url.search,
      headers,
      query: url.search.slice(1),
      body: options.body || '',
    });

    // Make HTTP request
    return new Promise((resolve, reject) => {
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: signedHeaders,
      }, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body,
            });
          } else {
            const error = new Error(`S3 request failed: ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.body = body.toString();
            reject(error);
          }
        });
      });

      req.on('error', reject);

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }

  /**
   * Parse S3 LIST response XML
   */
  _parseListResponse(xmlBuffer) {
    const xml = xmlBuffer.toString();

    // Simple XML parsing for LIST response
    const objects = [];
    const commonPrefixes = [];

    // Extract objects
    const contentsRegex = /<Contents>(.*?)<\/Contents>/gs;
    let match;
    while ((match = contentsRegex.exec(xml)) !== null) {
      const keyMatch = /<Key>(.*?)<\/Key>/.exec(match[1]);
      const sizeMatch = /<Size>(.*?)<\/Size>/.exec(match[1]);
      const lastModifiedMatch = /<LastModified>(.*?)<\/LastModified>/.exec(match[1]);

      if (keyMatch) {
        objects.push({
          key: keyMatch[1],
          size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
          lastModified: lastModifiedMatch ? new Date(lastModifiedMatch[1]) : new Date(),
        });
      }
    }

    // Extract common prefixes (directories)
    const prefixRegex = /<CommonPrefixes>.*?<Prefix>(.*?)<\/Prefix>.*?<\/CommonPrefixes>/gs;
    while ((match = prefixRegex.exec(xml)) !== null) {
      commonPrefixes.push(match[1]);
    }

    return { objects, commonPrefixes };
  }
}

module.exports = { S3Client };
