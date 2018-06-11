import React from 'react'
import { createStore } from 'redux'
import immer from 'immer'
import qs from 'query-string'
import Router from 'next/router'
import fetch from 'isomorphic-fetch'
import cookie from 'isomorphic-cookie'
import { format } from 'url'
import util from './util'
import page from './page'

const { Provider, Consumer } = React.createContext()
const EmptyView = () => null

export default class Controller {
  static Provider = Provider
  static Consumer = Consumer
  static page(...args) {
    return page(...args)(this)
  }

  constructor(context) {
    this.context = context
    this.urlPrefix = ''
    this.immer = true
    this.SSR = true
    this.API = null
    this.Model = null
    this.View = EmptyView
    this.store = null
    this.actions = {}
    this.reducer = null
    this.enhancer = undefined
    this.initialState = null
  }

  get isServer() {
    return this.context.isServer
  }

  get isClient() {
    return this.context.isClient
  }

  get location() {
    if (this.isServer) {
      return this.context.location
    } else if (this.isClient) {
      return {
        pathname: Router.pathname,
        query: Router.query,
        raw: Router.asPath
      }
    }
  }

  set location(_) {
    throw new Error('Property "location" is readonly')
  }

  createStore(reducer, preloadState, enhancer) {
    // handle object type
    if (typeof reducer === 'object') {
      const handlers = reducer
      reducer = (state, action) => {
        let handler = handlers[action.type]
        if (typeof handler === 'function') {
          if (this.immer) {
            return immer(state, draft => {
              handler(draft, action.payload)
            })
          } else {
            return handler(state, action.payload)
          }
        }
        return state
      }
      Object.keys(handlers).forEach(type => {
        this.actions[type] = payload => this.store.dispatch({ type, payload })
      })
    }
    return createStore(reducer, preloadState, enhancer)
  }

  dispatch(...args) {
    return this.store.dispatch(...args)
  }

  get state() {
    return this.store.getState()
  }

  set state(_) {
    throw new Error('Property "state" is readonly')
  }

  async $init(preloadState) {
    let { Model, reducer, initialState, enhancer } = this

    // if Model is set, { initialState, reducer, enhancer } = Model
    if (Model) {
      initialState = Model.initialState
      reducer = Model.reducer
      enhancer = Model.enhancer
    }

    // merge state
    let finalInitialState = {
      ...initialState,
      ...preloadState
    }

    // create store
    this.store = this.createStore(reducer, finalInitialState, enhancer)

    // if preloadState is got, return true
    if (preloadState) {
      return true
    }

    // call onCreate if needed
    if (this.onCreate) {
      await this.onCreate()
    }

    // if it was redirected by this.onCreate, return false
    let redirected = (this.isServer && this.context.res.finished) || (this.isClient && this.context.finished)

    if (redirected) {
      return false
    }

    // default is true
    return true
  }

  $destroy() {
    // placeholder
  }

  // router properties and methods
  get router() {
    return Router
  }

  set router(_) {
    throw new Error('Property "router" is readonly')
  }

  // redirect or page transition
  go(url, replace = false) {
    let { context } = this

    // handle url object
    if (typeof url !== 'object') {
      url = format(url)
    }

    // handle server side redirect
    if (this.isServer) {
      // https://github.com/zeit/next.js/wiki/Redirecting-in-%60getInitialProps%60
      context.res.writeHead(302, { Location: url })
      context.res.end()
      contex.res.finished = true
      return
    }

    // handle absolute url
    if (util.isAbsoluteUrl(url)) {
      if (replace) {
        window.location.replace(url)
      } else {
        window.location.href = url
      }
      return
    }

    // handle pushState
    if (replace) {
      Router.replace(url)
    } else {
      Router.push(url)
    }
    context.finished = true
  }

  // reload without refresh page
  reload() {
    this.go(this.location.raw, true)
  }

  // get config
  getConfig(name) {
    let config = {
      ...this.context.publicRuntimeConfig,
      ...this.context.serverRuntimeConfig
    }
    return config[name]
  }

  // fetch and relative utilities
  prependUrlPrefix(url) {
    let urlPrefix = this.urlPrefix || this.getConfig('urlPrefix') || ''
    return urlPrefix + url
  }
  /**
   * fetch, https://github.github.io/fetch
   * options.json === false, it should not convert response to json automatically
   * options.timeout:number request timeout
   * options.raw === true, it should not add prefix to url
   */
  fetch(url, options = {}) {
    let { context, API } = this

    /**
     * API shortcut
     */
    if (API && Object.prototype.hasOwnProperty.call(API, url)) {
      url = API[url]
    }

    // add prefix to url
    if (!options.raw) {
      url = this.prependUrlPrefix(url)
    }

    let finalOptions = {
      method: 'GET',
      credentials: 'include',
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers }
    }

    /**
     * add cookie from context.req in server side
     */
    if (this.isServer && finalOptions.credentials === 'include') {
      finalOptions.headers['Cookie'] = context.req.headers.cookie || ''
    }

    let fetchData = fetch(url, finalOptions)

    /**
     * parse json automatically
     */
    if (options.json !== false) {
      fetchData = fetchData.then(util.toJSON)
    }

    /**
     * handle timeout
     */
    if (typeof options.timeout === 'number') {
      fetchData = timeoutReject(fetchData, options.timeout)
    }

    return fetchData
  }

  /**
   *
   * get method
   */
  get(url, params, options) {
    let { API } = this
    /**
     * API shortcut
     */
    if (API && Object.prototype.hasOwnProperty.call(API, url)) {
      url = API[url]
    }

    // handle url params
    if (params) {
      let delimiter = url.indexOf('?') !== -1 ? '&' : '?'
      url += delimiter + qs.stringify(params)
    }

    return this.fetch(url, {
      ...options,
      method: 'GET'
    })
  }
  /**
   *
   * post method
   */
  post(url, data, options) {
    return this.fetch(url, {
      ...options,
      method: 'POST',
      body: typeof data === 'object' ? JSON.stringify(data) : String(data)
    })
  }

  // cookie utilities
  cookie(key, value, options) {
    if (value == null) {
      return this.getCookie(key)
    }
    this.setCookie(key, value, options)
  }

  getCookie(key) {
    return cookie.get(key, this.context.req)
  }

  setCookie(key, value, options) {
    //  Value can be a Number which will be interpreted as days from time of creation or a Date
    if (options && typeof options.expires === 'number') {
      options = {
        ...options,
        expires: new Date(new Date() * 1 + options.expires * 864e5)
      }
    }
    cookie.set(key, value, options, this.context.res)
  }

  removeCookie(key, options) {
    cookie.remove(key, options, this.context.res)
  }

  // render component
  render() {
    let { View } = this
    return (
      <Provider value={this}>
        <View state={this.state} ctrl={this} controller={this} />
      </Provider>
    )
  }
}
