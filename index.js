'use strict'

const { URL } = require('url')
const net = require('net')
const Q = require('fastq')
const { HTTPParser } = require('http-parser-js')
const { Readable } = require('readable-stream')

class Undici {
  constructor (url) {
    if (!(url instanceof URL)) {
      url = new URL(url)
    }

    // TODO support TSL
    this.socket = net.connect(url.port, url.hostname)

    this.parser = new HTTPParser(HTTPParser.RESPONSE)

    // TODO support http pipelining
    this.q = Q((request, cb) => {
      var { method, path, body } = request
      var req = `${method} ${path} HTTP/1.1\r\nHost: ${url.hostname}\r\nConnection: keep-alive\r\n`

      this.socket.cork()
      this.socket.write(req, 'ascii')

      if (typeof body === 'string' || body instanceof Uint8Array) {
        this.socket.write('content-length: ' + Buffer.byteLength(body) + '\r\n', 'ascii')
        this.socket.write('\r\n', 'ascii')
        this.socket.write(body)
      }
      // TODO support streams

      this.socket.write('\r\n', 'ascii')
      this.socket.uncork()

      this._needHeaders = true
      this._lastCb = cb
      read()
    }, 1)

    this.q.pause()

    this._needHeaders = false
    this._lastBody = null

    this.socket.on('connect', () => {
      this.q.resume()
    })

    this.parser[HTTPParser.kOnHeaders] = () => {}
    this.parser[HTTPParser.kOnHeadersComplete] = ({ statusCode, headers }) => {
      const cb = this._lastCb
      this._needHeaders = false
      this._lastBody = new Readable({ read })
      this._lastCb = null
      cb(null, {
        statusCode,
        headers: parseHeaders(headers),
        body: this._lastBody
      })
    }

    this.parser[HTTPParser.kOnBody] = (chunk, offset, length) => {
      this._lastBody.push(chunk.slice(offset, offset + length))
    }

    this.parser[HTTPParser.kOnMessageComplete] = () => {
      const body = this._lastBody
      this._lastBody = null
      body.push(null)
    }

    const read = () => {
      if (!this.socket) {
        // TODO this should not happen
        return
      }

      var chunk = null
      var hasRead = false
      while ((chunk = this.socket.read()) !== null) {
        hasRead = true
        this.parser.execute(chunk)
      }

      if (!hasRead || this._needHeaders) {
        this.socket.once('readable', read)
      }
    }
  }

  call (opts, cb) {
    // TODO validate body type
    // TODO validate that the body is a string, buffer or stream
    this.q.push(opts, cb)
  }

  close () {
    if (this.socket) {
      // TODO make sure we error everything that
      // is in flight
      this.q.kill()
      this.socket.end()
      this.socket = null
    }
  }
}

function parseHeaders (headers) {
  const obj = {}
  for (var i = 0; i < headers.length; i += 2) {
    var key = headers[i]
    if (!obj[key]) {
      obj[key] = headers[i + 1]
    } else {
      obj[key].push(headers[i + 1])
    }
  }
  return obj
}

module.exports = Undici
