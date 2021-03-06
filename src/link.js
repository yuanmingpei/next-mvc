import React from 'react'
import NextLink from 'next/link'
import getConfig from 'next/config'

export default function Link(props) {
	let config = getConfig() || {}
	let { appPrefix = '' } = config.publicRuntimeConfig || {}
	let as = !props.raw ? appPrefix + props.href : props.as || props.href
	return <NextLink {...props} as={as} />
}
