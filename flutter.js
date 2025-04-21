<<<<<<< HEAD
// Copyright 2014 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

if (!_flutter) {
  var _flutter = {};
}
_flutter.loader = null;

(function () {
  "use strict";

  const baseUri = ensureTrailingSlash(getBaseURI());

  function getBaseURI() {
    const base = document.querySelector("base");
    return (base && base.getAttribute("href")) || "";
  }

  function ensureTrailingSlash(uri) {
    if (uri == "") {
      return uri;
    }
    return uri.endsWith("/") ? uri : `${uri}/`;
  }

  /**
   * Wraps `promise` in a timeout of the given `duration` in ms.
   *
   * Resolves/rejects with whatever the original `promises` does, or rejects
   * if `promise` takes longer to complete than `duration`. In that case,
   * `debugName` is used to compose a legible error message.
   *
   * If `duration` is < 0, the original `promise` is returned unchanged.
   * @param {Promise} promise
   * @param {number} duration
   * @param {string} debugName
   * @returns {Promise} a wrapped promise.
   */
  async function timeout(promise, duration, debugName) {
    if (duration < 0) {
      return promise;
    }
    let timeoutId;
    const _clock = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `${debugName} took more than ${duration}ms to resolve. Moving on.`,
            {
              cause: timeout,
            }
          )
        );
      }, duration);
    });

    return Promise.race([promise, _clock]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Handles the creation of a TrustedTypes `policy` that validates URLs based
   * on an (optional) incoming array of RegExes.
   */
  class FlutterTrustedTypesPolicy {
    /**
     * Constructs the policy.
     * @param {[RegExp]} validPatterns the patterns to test URLs
     * @param {String} policyName the policy name (optional)
     */
    constructor(validPatterns, policyName = "flutter-js") {
      const patterns = validPatterns || [
        /\.js$/,
      ];
      if (window.trustedTypes) {
        this.policy = trustedTypes.createPolicy(policyName, {
          createScriptURL: function(url) {
            const parsed = new URL(url, window.location);
            const file = parsed.pathname.split("/").pop();
            const matches = patterns.some((pattern) => pattern.test(file));
            if (matches) {
              return parsed.toString();
            }
            console.error(
              "URL rejected by TrustedTypes policy",
              policyName, ":", url, "(download prevented)");
          }
        });
      }
    }
  }

  /**
   * Handles loading/reloading Flutter's service worker, if configured.
   *
   * @see: https://developers.google.com/web/fundamentals/primers/service-workers
   */
  class FlutterServiceWorkerLoader {
    /**
     * Injects a TrustedTypesPolicy (or undefined if the feature is not supported).
     * @param {TrustedTypesPolicy | undefined} policy
     */
    setTrustedTypesPolicy(policy) {
      this._ttPolicy = policy;
    }

    /**
     * Returns a Promise that resolves when the latest Flutter service worker,
     * configured by `settings` has been loaded and activated.
     *
     * Otherwise, the promise is rejected with an error message.
     * @param {*} settings Service worker settings
     * @returns {Promise} that resolves when the latest serviceWorker is ready.
     */
    loadServiceWorker(settings) {
      if (settings == null) {
        // In the future, settings = null -> uninstall service worker?
        console.debug("Null serviceWorker configuration. Skipping.");
        return Promise.resolve();
      }
      if (!("serviceWorker" in navigator)) {
        let errorMessage = "Service Worker API unavailable.";
        if (!window.isSecureContext) {
          errorMessage += "\nThe current context is NOT secure."
          errorMessage += "\nRead more: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts";
        }
        return Promise.reject(
          new Error(errorMessage)
        );
      }
      const {
        serviceWorkerVersion,
        serviceWorkerUrl = `${baseUri}flutter_service_worker.js?v=${serviceWorkerVersion}`,
        timeoutMillis = 4000,
      } = settings;

      // Apply the TrustedTypes policy, if present.
      let url = serviceWorkerUrl;
      if (this._ttPolicy != null) {
        url = this._ttPolicy.createScriptURL(url);
      }

      const serviceWorkerActivation = navigator.serviceWorker
        .register(url)
        .then((serviceWorkerRegistration) => this._getNewServiceWorker(serviceWorkerRegistration, serviceWorkerVersion))
        .then(this._waitForServiceWorkerActivation);

      // Timeout race promise
      return timeout(
        serviceWorkerActivation,
        timeoutMillis,
        "prepareServiceWorker"
      );
    }

    /**
     * Returns the latest service worker for the given `serviceWorkerRegistration`.
     *
     * This might return the current service worker, if there's no new service worker
     * awaiting to be installed/updated.
     *
     * @param {ServiceWorkerRegistration} serviceWorkerRegistration
     * @param {String} serviceWorkerVersion
     * @returns {Promise<ServiceWorker>}
     */
    async _getNewServiceWorker(serviceWorkerRegistration, serviceWorkerVersion) {
      if (!serviceWorkerRegistration.active && (serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting)) {
        // No active web worker and we have installed or are installing
        // one for the first time. Simply wait for it to activate.
        console.debug("Installing/Activating first service worker.");
        return serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting;
      } else if (!serviceWorkerRegistration.active.scriptURL.endsWith(serviceWorkerVersion)) {
        // When the app updates the serviceWorkerVersion changes, so we
        // need to ask the service worker to update.
        const newRegistration = await serviceWorkerRegistration.update();
        console.debug("Updating service worker.");
        return newRegistration.installing || newRegistration.waiting || newRegistration.active;
      } else {
        console.debug("Loading from existing service worker.");
        return serviceWorkerRegistration.active;
      }
    }

    /**
     * Returns a Promise that resolves when the `serviceWorker` changes its
     * state to "activated".
     *
     * @param {ServiceWorker} serviceWorker
     * @returns {Promise<void>}
     */
    async _waitForServiceWorkerActivation(serviceWorker) {
      if (!serviceWorker || serviceWorker.state == "activated") {
        if (!serviceWorker) {
          throw new Error("Cannot activate a null service worker!");
        } else {
          console.debug("Service worker already active.");
          return;
        }
      }
      return new Promise((resolve, _) => {
        serviceWorker.addEventListener("statechange", () => {
          if (serviceWorker.state == "activated") {
            console.debug("Activated new service worker.");
            resolve();
          }
        });
      });
    }
  }

  /**
   * Handles injecting the main Flutter web entrypoint (main.dart.js), and notifying
   * the user when Flutter is ready, through `didCreateEngineInitializer`.
   *
   * @see https://docs.flutter.dev/development/platform-integration/web/initialization
   */
  class FlutterEntrypointLoader {
    /**
     * Creates a FlutterEntrypointLoader.
     */
    constructor() {
      // Watchdog to prevent injecting the main entrypoint multiple times.
      this._scriptLoaded = false;
    }

    /**
     * Injects a TrustedTypesPolicy (or undefined if the feature is not supported).
     * @param {TrustedTypesPolicy | undefined} policy
     */
    setTrustedTypesPolicy(policy) {
      this._ttPolicy = policy;
    }

    /**
     * Loads flutter main entrypoint, specified by `entrypointUrl`, and calls a
     * user-specified `onEntrypointLoaded` callback with an EngineInitializer
     * object when it's done.
     *
     * @param {*} options
     * @returns {Promise | undefined} that will eventually resolve with an
     * EngineInitializer, or will be rejected with the error caused by the loader.
     * Returns undefined when an `onEntrypointLoaded` callback is supplied in `options`.
     */
    async loadEntrypoint(options) {
      const { entrypointUrl = `${baseUri}main.dart.js`, onEntrypointLoaded } =
        options || {};

      return this._loadEntrypoint(entrypointUrl, onEntrypointLoaded);
    }

    /**
     * Resolves the promise created by loadEntrypoint, and calls the `onEntrypointLoaded`
     * function supplied by the user (if needed).
     *
     * Called by Flutter through `_flutter.loader.didCreateEngineInitializer` method,
     * which is bound to the correct instance of the FlutterEntrypointLoader by
     * the FlutterLoader object.
     *
     * @param {Function} engineInitializer @see https://github.com/flutter/engine/blob/main/lib/web_ui/lib/src/engine/js_interop/js_loader.dart#L42
     */
    didCreateEngineInitializer(engineInitializer) {
      if (typeof this._didCreateEngineInitializerResolve === "function") {
        this._didCreateEngineInitializerResolve(engineInitializer);
        // Remove the resolver after the first time, so Flutter Web can hot restart.
        this._didCreateEngineInitializerResolve = null;
        // Make the engine revert to "auto" initialization on hot restart.
        delete _flutter.loader.didCreateEngineInitializer;
      }
      if (typeof this._onEntrypointLoaded === "function") {
        this._onEntrypointLoaded(engineInitializer);
      }
    }

    /**
     * Injects a script tag into the DOM, and configures this loader to be able to
     * handle the "entrypoint loaded" notifications received from Flutter web.
     *
     * @param {string} entrypointUrl the URL of the script that will initialize
     *                 Flutter.
     * @param {Function} onEntrypointLoaded a callback that will be called when
     *                   Flutter web notifies this object that the entrypoint is
     *                   loaded.
     * @returns {Promise | undefined} a Promise that resolves when the entrypoint
     *                                is loaded, or undefined if `onEntrypointLoaded`
     *                                is a function.
     */
    _loadEntrypoint(entrypointUrl, onEntrypointLoaded) {
      const useCallback = typeof onEntrypointLoaded === "function";

      if (!this._scriptLoaded) {
        this._scriptLoaded = true;
        const scriptTag = this._createScriptTag(entrypointUrl);
        if (useCallback) {
          // Just inject the script tag, and return nothing; Flutter will call
          // `didCreateEngineInitializer` when it's done.
          console.debug("Injecting <script> tag. Using callback.");
          this._onEntrypointLoaded = onEntrypointLoaded;
          document.body.append(scriptTag);
        } else {
          // Inject the script tag and return a promise that will get resolved
          // with the EngineInitializer object from Flutter when it calls
          // `didCreateEngineInitializer` later.
          return new Promise((resolve, reject) => {
            console.debug(
              "Injecting <script> tag. Using Promises. Use the callback approach instead!"
            );
            this._didCreateEngineInitializerResolve = resolve;
            scriptTag.addEventListener("error", reject);
            document.body.append(scriptTag);
          });
        }
      }
    }

    /**
     * Creates a script tag for the given URL.
     * @param {string} url
     * @returns {HTMLScriptElement}
     */
    _createScriptTag(url) {
      const scriptTag = document.createElement("script");
      scriptTag.type = "application/javascript";
      // Apply TrustedTypes validation, if available.
      let trustedUrl = url;
      if (this._ttPolicy != null) {
        trustedUrl = this._ttPolicy.createScriptURL(url);
      }
      scriptTag.src = trustedUrl;
      return scriptTag;
    }
  }

  /**
   * The public interface of _flutter.loader. Exposes two methods:
   * * loadEntrypoint (which coordinates the default Flutter web loading procedure)
   * * didCreateEngineInitializer (which is called by Flutter to notify that its
   *                              Engine is ready to be initialized)
   */
  class FlutterLoader {
    /**
     * Initializes the Flutter web app.
     * @param {*} options
     * @returns {Promise?} a (Deprecated) Promise that will eventually resolve
     *                     with an EngineInitializer, or will be rejected with
     *                     any error caused by the loader. Or Null, if the user
     *                     supplies an `onEntrypointLoaded` Function as an option.
     */
    async loadEntrypoint(options) {
      const { serviceWorker, ...entrypoint } = options || {};

      // A Trusted Types policy that is going to be used by the loader.
      const flutterTT = new FlutterTrustedTypesPolicy();

      // The FlutterServiceWorkerLoader instance could be injected as a dependency
      // (and dynamically imported from a module if not present).
      const serviceWorkerLoader = new FlutterServiceWorkerLoader();
      serviceWorkerLoader.setTrustedTypesPolicy(flutterTT.policy);
      await serviceWorkerLoader.loadServiceWorker(serviceWorker).catch(e => {
        // Regardless of what happens with the injection of the SW, the show must go on
        console.warn("Exception while loading service worker:", e);
      });

      // The FlutterEntrypointLoader instance could be injected as a dependency
      // (and dynamically imported from a module if not present).
      const entrypointLoader = new FlutterEntrypointLoader();
      entrypointLoader.setTrustedTypesPolicy(flutterTT.policy);
      // Install the `didCreateEngineInitializer` listener where Flutter web expects it to be.
      this.didCreateEngineInitializer =
        entrypointLoader.didCreateEngineInitializer.bind(entrypointLoader);
      return entrypointLoader.loadEntrypoint(entrypoint);
    }
  }

  _flutter.loader = new FlutterLoader();
})();
=======
(()=>{var P=()=>navigator.vendor==="Google Inc."||navigator.agent==="Edg/",E=()=>typeof ImageDecoder>"u"?!1:P(),L=()=>typeof Intl.v8BreakIterator<"u"&&typeof Intl.Segmenter<"u",W=()=>{let n=[0,97,115,109,1,0,0,0,1,5,1,95,1,120,0];return WebAssembly.validate(new Uint8Array(n))},w={hasImageCodecs:E(),hasChromiumBreakIterators:L(),supportsWasmGC:W(),crossOriginIsolated:window.crossOriginIsolated};function l(...n){return new URL(C(...n),document.baseURI).toString()}function C(...n){return n.filter(t=>!!t).map((t,i)=>i===0?_(t):j(_(t))).filter(t=>t.length).join("/")}function j(n){let t=0;for(;t<n.length&&n.charAt(t)==="/";)t++;return n.substring(t)}function _(n){let t=n.length;for(;t>0&&n.charAt(t-1)==="/";)t--;return n.substring(0,t)}function T(n,t){return n.canvasKitBaseUrl?n.canvasKitBaseUrl:t.engineRevision&&!t.useLocalCanvasKit?C("https://www.gstatic.com/flutter-canvaskit",t.engineRevision):"canvaskit"}var v=class{constructor(){this._scriptLoaded=!1}setTrustedTypesPolicy(t){this._ttPolicy=t}async loadEntrypoint(t){let{entrypointUrl:i=l("main.dart.js"),onEntrypointLoaded:r,nonce:e}=t||{};return this._loadJSEntrypoint(i,r,e)}async load(t,i,r,e,a){a??=o=>{o.initializeEngine(r).then(c=>c.runApp())};let{entryPointBaseUrl:s}=r;if(t.compileTarget==="dart2wasm")return this._loadWasmEntrypoint(t,i,s,a);{let o=t.mainJsPath??"main.dart.js",c=l(s,o);return this._loadJSEntrypoint(c,a,e)}}didCreateEngineInitializer(t){typeof this._didCreateEngineInitializerResolve=="function"&&(this._didCreateEngineInitializerResolve(t),this._didCreateEngineInitializerResolve=null,delete _flutter.loader.didCreateEngineInitializer),typeof this._onEntrypointLoaded=="function"&&this._onEntrypointLoaded(t)}_loadJSEntrypoint(t,i,r){let e=typeof i=="function";if(!this._scriptLoaded){this._scriptLoaded=!0;let a=this._createScriptTag(t,r);if(e)console.debug("Injecting <script> tag. Using callback."),this._onEntrypointLoaded=i,document.head.append(a);else return new Promise((s,o)=>{console.debug("Injecting <script> tag. Using Promises. Use the callback approach instead!"),this._didCreateEngineInitializerResolve=s,a.addEventListener("error",o),document.head.append(a)})}}async _loadWasmEntrypoint(t,i,r,e){if(!this._scriptLoaded){this._scriptLoaded=!0,this._onEntrypointLoaded=e;let{mainWasmPath:a,jsSupportRuntimePath:s}=t,o=l(r,a),c=l(r,s);this._ttPolicy!=null&&(c=this._ttPolicy.createScriptURL(c));let d=(await import(c)).compileStreaming(fetch(o)),f;t.renderer==="skwasm"?f=(async()=>{let m=await i.skwasm;return window._flutter_skwasmInstance=m,{skwasm:m.wasmExports,skwasmWrapper:m,ffi:{memory:m.wasmMemory}}})():f=Promise.resolve({}),await(await(await d).instantiate(await f)).invokeMain()}}_createScriptTag(t,i){let r=document.createElement("script");r.type="application/javascript",i&&(r.nonce=i);let e=t;return this._ttPolicy!=null&&(e=this._ttPolicy.createScriptURL(t)),r.src=e,r}};async function I(n,t,i){if(t<0)return n;let r,e=new Promise((a,s)=>{r=setTimeout(()=>{s(new Error(`${i} took more than ${t}ms to resolve. Moving on.`,{cause:I}))},t)});return Promise.race([n,e]).finally(()=>{clearTimeout(r)})}var y=class{setTrustedTypesPolicy(t){this._ttPolicy=t}loadServiceWorker(t){if(!t)return console.debug("Null serviceWorker configuration. Skipping."),Promise.resolve();if(!("serviceWorker"in navigator)){let o="Service Worker API unavailable.";return window.isSecureContext||(o+=`
The current context is NOT secure.`,o+=`
Read more: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts`),Promise.reject(new Error(o))}let{serviceWorkerVersion:i,serviceWorkerUrl:r=l(`flutter_service_worker.js?v=${i}`),timeoutMillis:e=4e3}=t,a=r;this._ttPolicy!=null&&(a=this._ttPolicy.createScriptURL(a));let s=navigator.serviceWorker.register(a).then(o=>this._getNewServiceWorker(o,i)).then(this._waitForServiceWorkerActivation);return I(s,e,"prepareServiceWorker")}async _getNewServiceWorker(t,i){if(!t.active&&(t.installing||t.waiting))return console.debug("Installing/Activating first service worker."),t.installing||t.waiting;if(t.active.scriptURL.endsWith(i))return console.debug("Loading from existing service worker."),t.active;{let r=await t.update();return console.debug("Updating service worker."),r.installing||r.waiting||r.active}}async _waitForServiceWorkerActivation(t){if(!t||t.state==="activated")if(t){console.debug("Service worker already active.");return}else throw new Error("Cannot activate a null service worker!");return new Promise((i,r)=>{t.addEventListener("statechange",()=>{t.state==="activated"&&(console.debug("Activated new service worker."),i())})})}};var g=class{constructor(t,i="flutter-js"){let r=t||[/\.js$/,/\.mjs$/];window.trustedTypes&&(this.policy=trustedTypes.createPolicy(i,{createScriptURL:function(e){if(e.startsWith("blob:"))return e;let a=new URL(e,window.location),s=a.pathname.split("/").pop();if(r.some(c=>c.test(s)))return a.toString();console.error("URL rejected by TrustedTypes policy",i,":",e,"(download prevented)")}}))}};var k=n=>{let t=WebAssembly.compileStreaming(fetch(n));return(i,r)=>((async()=>{let e=await t,a=await WebAssembly.instantiate(e,i);r(a,e)})(),{})};var b=(n,t,i,r)=>(window.flutterCanvasKitLoaded=(async()=>{if(window.flutterCanvasKit)return window.flutterCanvasKit;let e=i.hasChromiumBreakIterators&&i.hasImageCodecs;if(!e&&t.canvasKitVariant=="chromium")throw"Chromium CanvasKit variant specifically requested, but unsupported in this browser";let a=e&&t.canvasKitVariant!=="full",s=r;a&&(s=l(s,"chromium"));let o=l(s,"canvaskit.js");n.flutterTT.policy&&(o=n.flutterTT.policy.createScriptURL(o));let c=k(l(s,"canvaskit.wasm")),p=await import(o);return window.flutterCanvasKit=await p.default({instantiateWasm:c}),window.flutterCanvasKit})(),window.flutterCanvasKitLoaded);var U=async(n,t,i,r)=>{let e=i.crossOriginIsolated&&!t.forceSingleThreadedSkwasm?"skwasm":"skwasm_st",s=l(r,`${e}.js`);n.flutterTT.policy&&(s=n.flutterTT.policy.createScriptURL(s));let o=k(l(r,`${e}.wasm`));return await(await import(s)).default({instantiateWasm:o,mainScriptUrlOrBlob:new Blob([`import '${s}'`],{type:"application/javascript"})})};var S=class{async loadEntrypoint(t){let{serviceWorker:i,...r}=t||{},e=new g,a=new y;a.setTrustedTypesPolicy(e.policy),await a.loadServiceWorker(i).catch(o=>{console.warn("Exception while loading service worker:",o)});let s=new v;return s.setTrustedTypesPolicy(e.policy),this.didCreateEngineInitializer=s.didCreateEngineInitializer.bind(s),s.loadEntrypoint(r)}async load({serviceWorkerSettings:t,onEntrypointLoaded:i,nonce:r,config:e}={}){e??={};let a=_flutter.buildConfig;if(!a)throw"FlutterLoader.load requires _flutter.buildConfig to be set";let s=u=>{switch(u){case"skwasm":return w.hasChromiumBreakIterators&&w.hasImageCodecs&&w.supportsWasmGC;default:return!0}},o=(u,m)=>{switch(u.renderer){case"auto":return m=="canvaskit"||m=="html";default:return u.renderer==m}},c=u=>u.compileTarget==="dart2wasm"&&!w.supportsWasmGC||e.renderer&&!o(u,e.renderer)?!1:s(u.renderer),p=a.builds.find(c);if(!p)throw"FlutterLoader could not find a build compatible with configuration and environment.";let d={};d.flutterTT=new g,t&&(d.serviceWorkerLoader=new y,d.serviceWorkerLoader.setTrustedTypesPolicy(d.flutterTT.policy),await d.serviceWorkerLoader.loadServiceWorker(t).catch(u=>{console.warn("Exception while loading service worker:",u)}));let f=T(e,a);p.renderer==="canvaskit"?d.canvasKit=b(d,e,w,f):p.renderer==="skwasm"&&(d.skwasm=U(d,e,w,f));let h=new v;return h.setTrustedTypesPolicy(d.flutterTT.policy),this.didCreateEngineInitializer=h.didCreateEngineInitializer.bind(h),h.load(p,d,e,r,i)}};window._flutter||(window._flutter={});window._flutter.loader||(window._flutter.loader=new S);})();
//# sourceMappingURL=flutter.js.map
>>>>>>> master
