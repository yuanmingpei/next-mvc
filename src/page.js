import React from 'react'
import { createStore } from 'redux'
import immer from 'immer'
import querystring from 'querystring'
import Router from 'next/router'
import getConfig, { setConfig } from 'next/config'
import fetch from 'isomorphic-fetch'
import cookie from './isomorphic/cookie'
import { format } from 'url'
import * as util from './util'

const isServer = typeof window === 'undefined'
const isClient = !isServer
const redirected = {}

export default class Page extends React.Component {
	static getInitialProps(context) {
		util.checkComponent(this)
		let { pathname, query, asPath, req, res } = context
		let config = getConfig() || {}
		let { appPrefix = '' } = config.publicRuntimeConfig || {}
		asPath = appPrefix + asPath

		let Page = this
		let page = new Page({ pathname, query, asPath, req, res })
		let redirect = page.redirect

		// throw error to make sure user code will not go on after redirected
		page.redirect = (...args) => {
			redirect.apply(page, args)
			throw redirected
		}

		// overwrite setState to prevent react transaction
		page.setState = (newState, callback) => {
			page.state = { ...page.state, ...newState }
			callback && callback()
		}

		let handleError = error => {
			if (error === redirected) return {}
			throw error
		}
		let handleInitialState = initialState => {
			if (util.isThenable(initialState)) {
				return initialState.then(handleInitialState, handleError)
			}

			// handle redirect
			if (res && res.finished) {
				return {}
			}

			initialState = {
				...page.state,
				...initialState
			}

			return {
				initialState,
				// make sure every url has its own react component instance
				key: asPath,
				pathname,
				query,
				asPath
			}
		}

		// handle get initial state
		if (page.getInitialState) {
			try {
				return handleInitialState(
					page.getInitialState({ ...context, ...page.props })
				)
			} catch (error) {
				handleError(error)
				return {}
			}
		} else {
			return handleInitialState()
		}
	}

	static getDerivedStateFromProps(props, state) {
		if (!state.$hydrate && props.initialState) {
			return {
				...state,
				...props.initialState,
				$hydrate: true
			}
		}
		return state
	}

	constructor(props) {
		if (props == null)
			throw new Error('You probably forget pass props to super(props)')
		super(props)
		this.apiPrefix = ''
		this.appPrefix = ''
		this.reduxDevtools = true
		this.immer = true
		this.API = null
		this.View = null
		this.$actions = null
		this.$store = null
		this.$cookie = cookie
		this.state = {}
	}

	render() {
		let { View } = this
		if (!View) {
			return null
		}
		return <View state={this.state} page={this} />
	}

	get store() {
		if (this.$store) return this.$store
		this.$store = this.createStore()
		return this.$store
	}

	get isServer() {
		return isServer
	}

	get isClient() {
		return isClient
	}

	getUserAgent() {
		if (isClient) {
			return window.navigator.userAgent
		}
		if (this.props.req) {
			throw new Error(
				'Calling "getUserAgent" in unsupported life-cycle method, such like constructor'
			)
		}
		return this.props.req.headers['user-agent']
	}

	get actions() {
		if (this.$actions) return this.$actions
		this.store // trigger createStore
		this.$actions = {}
		if (!util.isObject(this.reducer)) return this.$actions

		Object.keys(this.reducer).forEach(type => {
			this.$actions[type] = payload => this.store.dispatch({ type, payload })
		})

		return this.$actions
	}

	createReducer() {
		return (state, action) => {
			let reducer = this.reducer
			let nextState = state
			if (util.isObject(reducer)) {
				let handler = reducer[action.type]
				if (util.isFunction(handler)) {
					if (this.immer) {
						nextState = immer(nextState, draft => {
							handler(draft, action.payload)
						})
					} else {
						nextState = handler(nextState, action.payload)
					}
				}
			} else if (util.isFunction(reducer)) {
				nextState = reducer(nextState, action)
			}
			return nextState
		}
	}

	attachReduxDevtoolsIfNeeded(enhancer) {
		if (isClient && this.reduxDevtools && window.__REDUX_DEVTOOLS_EXTENSION__) {
			const options = {
				name: window.location.pathname + window.location.search
			}
			if (!enhancer) {
				enhancer = window.__REDUX_DEVTOOLS_EXTENSION__(options)
			} else {
				const composeEnhancers = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(
					options
				)
				enhancer = composeEnhancers(enhancer)
			}
		}
		return enhancer
	}

	createStore(enhancer) {
		let store = createStore(
			this.createReducer(),
			this.state,
			this.attachReduxDevtoolsIfNeeded(enhancer)
		)
		store.unsubscribe = store.subscribe(() => {
			let nextState = store.getState()
			this.setState(nextState)
		})
		Object.defineProperty(store, 'actions', {
			get: () => this.actions
		})
		return store
	}

	/**
	 * dispatch(type, payload)
	 * or
	 * dispatch({ type, payload })
	 */
	dispatch(type, payload) {
		let action = { type, payload }
		if (type != null && typeof type === 'object' && payload == null) {
			action = type
		}
		return this.store.dispatch(action)
	}

	// router properties and methods
	get router() {
		return Router
	}

	set router(_) {
		throw new Error('Property "router" is readonly')
	}

	// for api
	prependApiPrefix(path) {
		let apiPrefix = this.apiPrefix || this.getConfig('apiPrefix') || ''
		if (this.isServer && apiPrefix.indexOf('//') === 0) {
			apiPrefix = `http:${apiPrefix}`
		}
		return apiPrefix + path
	}

	// for app page transition
	prependAppPrefix(path) {
		let appPrefix = this.appPrefix || this.getConfig('appPrefix') || ''
		return appPrefix + path
	}

	// redirect or page transition
	goto(url, replace = false, raw = false) {
		let { props } = this

		// handle url object
		if (typeof url === 'object') {
			url = format(url)
		}

		if (url === '') {
			url = '/'
		}

		let originalUrl = url

		if (!util.isAbsoluteUrl(url) && !raw) {
			url = this.prependAppPrefix(url)
		}

		// handle server side redirect
		if (this.isServer) {
			// https://github.com/zeit/next.js/wiki/Redirecting-in-%60getInitialProps%60
			props.res.writeHead(302, { Location: url })
			props.res.end()
			props.res.finished = true
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

		// handle router
		if (replace) {
			Router.replace(originalUrl, url)
		} else {
			Router.push(originalUrl, url)
		}
	}

	redirect(url, raw) {
		this.goto(url, true, raw)
	}

	back() {
		return window.history.back()
	}

	forward() {
		return window.history.forward()
	}

	// get config
	getConfig(name) {
		let { publicRuntimeConfig, serverRuntimeConfig } = getConfig() || {}
		let config = {
			...publicRuntimeConfig,
			...serverRuntimeConfig
		}
		return config[name]
	}

	/**
	 * fetch, https://github.github.io/fetch
	 */
	fetch(api, options = {}) {
		let { props, API } = this

		/**
		 * API shortcut
		 */
		if (API && Object.prototype.hasOwnProperty.call(API, api)) {
			api = API[api]
		}

		// add prefix to api
		if (!options.raw) {
			api = this.prependApiPrefix(api)
		}

		let { responseType = 'json', response = false } = options
		let finalOptions = {
			method: 'GET',
			credentials: 'include',
			...options
		}

		/**
		 * add cookie from props.req in server side
		 */
		if (this.isServer && finalOptions.credentials === 'include') {
			finalOptions.headers = {
				...options.headers,
				Cookie: props.req.headers.cookie || ''
			}
		}

		// use options.fetch if existed
		let finalFetch = options.fetch || fetch
		let fetchData = finalFetch(api, finalOptions)

		/**
		 * parse to response type automatically
		 */
		if (!response && responseType) {
			fetchData = fetchData.then(res => {
				/**
				 * options.fetch may return data directly
				 * check whether res is response or not
				 */
				if (!util.isResponse(res)) return res
				if (!(responseType in res))
					throw new Error(`${responseType} type is unsupported`)
				return res[responseType]()
			})
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
	get(api, params, options) {
		let { API } = this
		/**
		 * API shortcut
		 */
		if (API && Object.prototype.hasOwnProperty.call(API, api)) {
			api = API[api]
		}

		// handle api params
		if (params) {
			let delimiter = api.indexOf('?') !== -1 ? '&' : '?'
			api += delimiter + querystring.stringify(params)
		}

		return this.fetch(api, {
			...options,
			method: 'GET'
		})
	}
	/**
	 *
	 * post method
	 */
	post(api, data, options = {}) {
		return this.fetch(api, {
			...options,
			headers: {
				...options.headers,
				'Content-Type': 'application/json'
			},
			method: 'POST',
			body: util.isPlainObject(data) ? JSON.stringify(data) : data
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
		return this.$cookie.get(key, this.props.req)
	}

	setCookie(key, value, options) {
		//  Value can be a Number which will be interpreted as days from time of creation or a Date
		if (options && typeof options.expires === 'number') {
			options = {
				...options,
				expires: new Date(new Date() * 1 + options.expires * 864e5)
			}
		}
		this.$cookie.set(key, value, options, this.props.res)
	}

	removeCookie(key, options) {
		this.$cookie.remove(key, options, this.props.res)
	}
}
