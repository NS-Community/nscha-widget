/*!
 * NSCHA widget — one script, one element, zero third-party requests.
 *
 *   <script src="https://your-nscha-host/widget.js" defer></script>
 *   <nscha-widget action="login"></nscha-widget>
 *
 * On success the element writes a hidden <input name="nschaToken"> into the
 * light DOM (so a surrounding <form> submits it automatically) and dispatches
 * `nscha:success` with { token, scope, elapsedMs }.
 *
 * The solver and its WASM payloads are loaded from the SAME origin as this
 * script. Nothing about the visitor is sent anywhere else.
 */
;(function () {
  'use strict'

  var OWN_SRC = document.currentScript && document.currentScript.src
  var BASE = OWN_SRC ? new URL(OWN_SRC, location.href).origin : location.origin

  // -------------------------------------------------------------------------
  // Solver configuration — MUST run before nscha-solver.js is evaluated.
  // That module fires a speculative prefetch at evaluation time, so setting
  // these globals any later would fall back to a public CDN and break the
  // same-origin promise. This ordering is load-bearing.
  // -------------------------------------------------------------------------
  window.CAP_CUSTOM_WASM_URL = BASE + '/cap/cap_wasm_bg.wasm'
  window.CAP_CUSTOM_HASHWX_URL = BASE + '/cap/hashwx.wasm'
  window.CAP_PAKO_URL = BASE + '/cap/pako_inflate.min.js'

  // Cap lets us wrap every fetch. We use it to carry the form's scope, which
  // the server binds into both the challenge and the redeem token. Because the
  // override is global, solves are serialised through the queue below and the
  // scope of the in-flight widget lives here.
  var activeScope = 'login'
  window.CAP_CUSTOM_FETCH = function (url, conf) {
    var init = conf || {}
    var headers = new Headers(init.headers || {})
    headers.set('x-captcha-scope', activeScope)
    return fetch(url, Object.assign({}, init, { headers: headers }))
  }

  var solverPromise = null
  function loadSolver() {
    if (window.Cap) return Promise.resolve(window.Cap)
    if (solverPromise) return solverPromise
    solverPromise = new Promise(function (resolve, reject) {
      var el = document.createElement('script')
      el.src = BASE + '/nscha-solver.js'
      el.async = true
      el.onload = function () {
        if (window.Cap) resolve(window.Cap)
        else reject(new Error('solver_unavailable'))
      }
      el.onerror = function () {
        solverPromise = null
        reject(new Error('solver_load_failed'))
      }
      document.head.appendChild(el)
    })
    return solverPromise
  }

  // The solver proxies addEventListener onto an internal EventTarget but does
  // NOT proxy removeEventListener. Bind exactly two listeners once for the
  // life of the page and route results through `pending`, instead of adding and
  // trying to remove a pair on every solve.
  var capInstance = null
  var pending = null

  function getCap() {
    if (capInstance) return Promise.resolve(capInstance)
    return loadSolver().then(function (CapCtor) {
      // Invisible mode: the solver attaches a display:none host to <html>, so
      // nothing but the box we draw below is ever visible to the visitor.
      var inst = new CapCtor({ apiEndpoint: BASE + '/' })

      inst.addEventListener('solve', function (ev) {
        if (!pending) return
        var p = pending
        pending = null
        clearTimeout(p.timer)
        p.resolve(ev && ev.detail ? String(ev.detail.token || '') : '')
      })
      inst.addEventListener('error', function (ev) {
        if (!pending) return
        var p = pending
        pending = null
        clearTimeout(p.timer)
        var code = ev && ev.detail ? ev.detail.code : 'solve_failed'
        p.reject(new Error(code || 'solve_failed'))
      })

      capInstance = inst
      return inst
    })
  }

  // A single device should never grind two puzzles at once.
  var queue = Promise.resolve()
  function enqueue(job) {
    var run = queue.then(job, job)
    queue = run.catch(function () {})
    return run
  }

  function solveOnce(scope) {
    return getCap().then(function (inst) {
      activeScope = scope
      if (typeof inst.reset === 'function') inst.reset()
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          pending = null
          reject(new Error('solve_timeout'))
        }, 30000)
        pending = { resolve: resolve, reject: reject, timer: timer }

        Promise.resolve(inst.solve && inst.solve()).catch(function (err) {
          if (!pending) return
          var p = pending
          pending = null
          clearTimeout(p.timer)
          p.reject(err)
        })
      })
    })
  }

  var MESSAGES = {
    solver_unavailable: '验证组件未能加载完成，请刷新页面重试。',
    solver_load_failed: '验证组件加载失败，请刷新页面重试。',
    wasm_load_failed: '验证组件加载失败，请刷新页面重试。',
    worker_spawn_failed: '浏览器环境不受支持，请更换浏览器后重试。',
    challenge_unsupported: '浏览器环境不受支持，请更换浏览器后重试。',
    invalid_solution: '验证未完成，请重试。',
    network_error: '网络异常，验证未完成，请重试。',
    redeem_failed: '网络异常，验证未完成，请重试。',
    solve_timeout: '验证超时，请重试。',
  }

  var STYLES = [
    ':host{display:block;width:304px;max-width:100%;color:#fff;',
    'font-family:Geist,"Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '*{box-sizing:border-box;}',
    '.box{display:flex;align-items:center;width:304px;max-width:100%;height:76px;',
    'padding:0 16px;background:#303030;border-radius:6px;user-select:none;}',
    '.trigger{display:flex;align-items:center;gap:14px;width:100%;height:100%;padding:0;',
    'font:inherit;color:inherit;text-align:left;background:none;border:0;cursor:pointer;}',
    '.trigger:disabled{cursor:default;}',
    '.trigger:focus-visible{outline:2px solid #95b806;outline-offset:3px;border-radius:4px;}',
    '.check{position:relative;flex:0 0 auto;width:28px;height:28px;border:1px solid #5a5a58;',
    'border-radius:4px;background:#1e1e1e;transition:background .2s,border-color .2s;}',
    '.trigger:not(:disabled):hover .check{border-color:#8a8a86;}',
    '.copy{display:flex;flex-direction:column;gap:4px;min-width:0;}',
    '.title{font-size:14px;line-height:1.25;white-space:nowrap;}',
    '.sub{font-size:11px;line-height:1.25;color:#8a8a86;white-space:nowrap;}',
    '.ring,.tick{position:absolute;inset:0;width:100%;height:100%;opacity:0;}',
    '.ring circle{fill:none;stroke-width:2.5;}',
    '.ring .track{stroke:#4a4a48;}',
    '.ring .arc{stroke:#95b806;stroke-linecap:round;stroke-dasharray:26 56;}',
    '.tick path{fill:none;stroke:#111;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;}',
    '.box[data-state=verifying] .check{border-color:transparent;background:transparent;}',
    '.box[data-state=verifying] .ring{opacity:1;animation:nscha-spin .9s linear infinite;}',
    '.box[data-state=done] .check{border-color:#95b806;background:#95b806;}',
    '.box[data-state=done] .tick{opacity:1;}',
    '.box[data-state=error] .check{border-color:#a8453c;background:transparent;}',
    '.box[data-state=error] .check::after{content:"!";position:absolute;inset:0;display:flex;',
    'align-items:center;justify-content:center;font-size:20px;font-weight:600;color:#cf5c50;}',
    '.status{margin:10px 0 0;font-size:11px;line-height:1.4;min-height:16px;}',
    '.status[data-state=verifying]{color:#8a8a86;}',
    '.status[data-state=done]{color:#95b806;}',
    '.status[data-state=error]{color:#cf5c50;cursor:pointer;}',
    '.brand{display:block;margin:6px 0 0;font-size:10px;letter-spacing:.06em;color:#6e6e6a;',
    'text-decoration:none;}',
    '.brand:hover{color:#95b806;}',
    '@keyframes nscha-spin{to{transform:rotate(360deg);}}',
    '@media (prefers-reduced-motion:reduce){.box[data-state=verifying] .ring{animation:none;}}',
    '@media (max-width:360px){:host,.box{width:100%;}}',
  ].join('')

  var TEMPLATE = [
    '<style>', STYLES, '</style>',
    '<div class="box" part="box" data-state="idle" role="group" aria-label="NSCHA 人机验证">',
    '  <button class="trigger" type="button">',
    '    <span class="check" aria-hidden="true">',
    '      <svg class="ring" viewBox="0 0 32 32"><circle class="track" cx="16" cy="16" r="13"/>',
    '        <circle class="arc" cx="16" cy="16" r="13"/></svg>',
    '      <svg class="tick" viewBox="0 0 32 32"><path d="M9 16.6l4.8 4.8L23.4 11"/></svg>',
    '    </span>',
    '    <span class="copy"><span class="title">我是人类</span>',
    '      <span class="sub">NSCHA · 无追踪验证</span></span>',
    '  </button>',
    '</div>',
    '<p class="status" part="status" data-state="idle" aria-live="polite"></p>',
    '<a class="brand" part="brand" target="_blank" rel="noopener noreferrer">NSCHA</a>',
  ].join('')

  class NschaWidget extends HTMLElement {
    static get observedAttributes() {
      return ['action', 'name', 'auto', 'link']
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' })
      this._state = 'idle'
      this._token = ''
    }

    get token() {
      return this._token
    }

    connectedCallback() {
      if (!this.shadowRoot.innerHTML) this.shadowRoot.innerHTML = TEMPLATE
      this._box = this.shadowRoot.querySelector('.box')
      this._status = this.shadowRoot.querySelector('.status')
      this._trigger = this.shadowRoot.querySelector('.trigger')
      this._brand = this.shadowRoot.querySelector('.brand')

      var link = this.getAttribute('link') || BASE
      this._brand.href = link
      this._brand.title = 'NSCHA · 无监控人机验证'

      this._trigger.addEventListener('click', () => this.start())
      this._status.addEventListener('click', () => {
        if (this._state === 'error') this.start()
      })
      this._syncHidden()
      this._setState('idle')

      if (this.getAttribute('auto') !== 'off') this.start()
    }

    attributeChangedCallback() {
      if (!this.isConnected) return
      this._syncHidden()
      if (this.getAttribute('link')) {
        this._brand.href = this.getAttribute('link')
      }
    }

    _scope() {
      return (this.getAttribute('action') || 'login').trim().toLowerCase()
    }

    _syncHidden() {
      var name = this.getAttribute('name') || 'nschaToken'
      var input = this.querySelector('input[type=hidden][data-nscha]')
      if (!input) {
        input = document.createElement('input')
        input.type = 'hidden'
        input.setAttribute('data-nscha', '')
        this.appendChild(input)
      }
      input.name = name
      input.value = this._token
      this._hidden = input
    }

    _setState(state, text) {
      this._state = state
      this._box.dataset.state = state
      this._status.dataset.state = state
      this._status.textContent = text || ''
      this._trigger.disabled = state === 'verifying' || state === 'done'
      this._trigger.setAttribute(
        'aria-label',
        state === 'done' ? '已通过人机验证' : state === 'verifying' ? '正在验证' : '开始人机验证'
      )
    }

    _emit(type, detail) {
      this.dispatchEvent(
        new CustomEvent(type, { detail: detail, bubbles: true, composed: true })
      )
    }

    /** Clear the token and return to idle. Always call this after a submit. */
    reset() {
      this._token = ''
      this._syncHidden()
      this._setState('idle')
      this._emit('nscha:reset', {})
    }

    start() {
      if (this._state === 'verifying' || this._state === 'done') return
      var self = this
      var started = Date.now()
      var scope = this._scope()
      this._token = ''
      this._syncHidden()
      this._setState('verifying', '正在本机计算…')

      return enqueue(function () {
        return solveOnce(scope)
      })
        .then(function (token) {
          if (!token) throw new Error('invalid_solution')
          self._token = token
          self._syncHidden()
          var ms = Date.now() - started
          self._setState('done', '已验证 · ' + ms + ' ms · 0 个第三方请求')
          self._emit('nscha:success', { token: token, scope: scope, elapsedMs: ms })
          return token
        })
        .catch(function (err) {
          var code = err && err.message ? err.message : 'solve_failed'
          var message = MESSAGES[code] || '验证未完成，请点击重试。'
          self._token = ''
          self._syncHidden()
          self._setState('error', message + '（点击重试）')
          self._emit('nscha:error', { message: message, code: code })
          return null
        })
    }
  }

  if (!customElements.get('nscha-widget')) {
    customElements.define('nscha-widget', NschaWidget)
  }
})()
