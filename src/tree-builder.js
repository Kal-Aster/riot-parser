/*---------------------------------------------------------------------
 * Tree builder for the riot tag parser.
 *
 * The output has a root property and separate arrays for `html`, `css`,
 * and `js` tags.
 *
 * The root tag is included as first element in the `html` array.
 * Script tags marked with "defer" are included in `html` instead `js`.
 *
 * - Mark SVG tags
 * - Mark raw tags
 * - Mark void tags
 * - Split prefixes from expressions
 * - Unescape escaped brackets and escape EOLs and backslashes
 * - Compact whitespace (option `compact`) for non-raw tags
 * - Create an array `parts` for text nodes and attributes
 *
 * Throws on unclosed tags or closing tags without start tag.
 * Selfclosing and void tags has no nodes[] property.
 */
import formatError from './format-error'
import * as MSG from './messages'
import voidTags from './void-tags'
import { TEXT, TAG, PRIVATE_JAVASCRIPT, PUBLIC_JAVASCRIPT } from './node-types'

// TODO: clean up this file

const SVG_NS = 'http://www.w3.org/2000/svg'
// Do not touch text content inside this tags
const RAW_TAGS = /^\/?(?:pre|textarea)$/

const JAVASCRIPT_OUTPUT_NAME = 'javascript'
const CSS_OUTPUT_NAME = 'css'
const TEMPLATE_OUTPUT_NAME = 'template'

const JAVASCRIPT_TAG = 'script'
const STYLE_TAG = 'style'

/**
 * Custom error handler can be implemented replacing this method.
 * The `state` object includes the buffer (`data`)
 * The error position (`loc`) contains line (base 1) and col (base 0).
 *
 * @param {string} msg   - Error message
 * @param {pos} [number] - Position of the error
 */
function err(msg, pos, data) {
  const message = formatError(data, msg, pos)
  throw new Error(message)
}

/**
 * Escape the carriage return and the line feed from a string
 * @param   {string} string - input string
 * @returns {string} output string escaped
 */
function escapeReturn(string) {
  return string
          .replace(/\r/g, '\\r')
          .replace(/\n/g, '\\n')
}

/**
 * Escape double slashes in a string
 * @param   {string} string - input string
 * @returns {string} output string escaped
 */
function escapeSlashes(string) {
  return string.replace(/\\/g, '\\\\')
}

/**
 * Replace the multiple spaces with only one
 * @param   {string} string - input string
 * @returns {string} string without trailing spaces
 */
function cleanSpaces(string) {
  return string.replace(/\s+/g, ' ')
}

const TREE_BUILDER_STRUCT = Object.seal({
  get() {
    const state = this.state
    // The real root tag is in state.root.nodes[0]
    return {
      [TEMPLATE_OUTPUT_NAME]: state.root.nodes[0],
      [CSS_OUTPUT_NAME]: state.style,
      [JAVASCRIPT_OUTPUT_NAME]: state.script,
    }
  },
 /**
  * Process the current tag or text.
  *
  * @param {Object} node - Raw pseudo-node from the parser
  */
  push(node) {
    const state = this.state
    if (node.type === TEXT) {
      this.pushText(state, node)
    } else if (node.type === TAG) {
      const name = node.name
      if (name[0] === '/') {
        this.closeTag(state, node, name)
      } else {
        this.openTag(state, node)
      }
    } else if ([PRIVATE_JAVASCRIPT, PUBLIC_JAVASCRIPT].includes(node.type)) {
      (state[JAVASCRIPT_TAG].nodes = state[JAVASCRIPT_TAG].nodes || []).push(node)
    }
  },
  closeTag(state, node, name) { // eslint-disable-line
    const last = state.scryle || state.last

    last.end = node.end

    if (state.scryle) {
      state.scryle = null
    } else {
      if (!state.stack[0]) {
        err('Stack is empty.', last.start, this.state.data)
      }
      state.last = state.stack.pop()
    }
  },

  openTag(state, node) {
    const name = node.name
    const ns = state.last.ns || (name === 'svg' ? SVG_NS : '')
    const attrs = node.attr
    if (attrs && !ns) {
      attrs.forEach(a => { a.name = a.name.toLowerCase() })
    }
    if ([JAVASCRIPT_TAG, STYLE_TAG].includes(name) && !this.deferred(node, attrs)) {
      // Only accept one of each
      if (state[name]) {
        err(MSG.duplicatedNamedTag.replace('%1', name), node.start, this.state.data)
      }
      state[name] = node
      // support selfclosing script (w/o text content)
      if (!node.selfclose) {
        state.scryle = state[name]
      }
    } else {
      // state.last holds the last tag pushed in the stack and this are
      // non-void, non-empty tags, so we are sure the `lastTag` here
      // have a `nodes` property.
      const lastTag = state.last
      const newNode = node
      lastTag.nodes.push(newNode)
      if (lastTag.raw || RAW_TAGS.test(name)) {
        newNode.raw = true
      }
      let voids
      if (ns) {
        newNode.ns = ns
        voids = voidTags.svg
      }
      else {
        voids = voidTags.html
      }
      if (voids.indexOf(name) !== -1) {
        newNode.void = true
      }
      else if (!node.selfclose) {
        state.stack.push(lastTag)
        newNode.nodes = []
        state.last = newNode
      }
    }
    if (attrs) {
      this.attrs(attrs)
    }
  },
  deferred(node, attributes) {
    if (attributes) {
      for (let i = 0; i < attributes.length; i++) {
        if (attributes[i].name === 'defer') {
          attributes.splice(i, 1)
          return true
        }
      }
    }
    return false
  },
  attrs(attributes) {
    for (let i = 0; i < attributes.length; i++) {
      const attr = attributes[i]
      if (attr.value) {
        this.split(attr, attr.value, attr.valueStart, true)
      }
    }
  },
  pushText(state, node) {
    const text = node.text
    const empty = !/\S/.test(text)
    const scryle = state.scryle
    if (!scryle) {
      // state.last always have a nodes property
      const parent = state.last
      const pack = this.compact && !parent.raw
      if (pack && empty) {
        return
      }
      this.split(node, text, node.start, pack)
      parent.nodes.push(node)
    } else if (!empty) {
      scryle.text = node
    }
  },
  split(node, source, start, pack) {
    const expressions = node.expr
    const parts = []
    if (expressions) {
      let pos = 0
      for (let i = 0; i < expressions.length; i++) {
        const expr = expressions[i]
        const text = source.slice(pos, expr.start - start)
        let code = expr.text
        if (this.prefixes.indexOf(code[0]) !== -1) {
          expr.prefix = code[0]
          code = code.substr(1)
        }
        parts.push(this._tt(node, text, pack), escapeReturn(escapeSlashes(code).trim()))
        pos = expr.end - start
      }
      if ((pos += start) < node.end) {
        parts.push(this._tt(node, source.slice(pos), pack))
      }
    }
    else {
      parts[0] = this._tt(node, source, pack)
    }
    node.parts = parts
  },
  // unescape escaped brackets and split prefixes of expressions
  _tt(node, text, pack) {
    let rep = node.unescape
    if (rep) {
      let idx = 0
      rep = `\\${rep}`
      while ((idx = text.indexOf(rep, idx)) !== -1) {
        text = text.substr(0, idx) + text.substr(idx + 1)
        idx++
      }
    }
    text = escapeSlashes(text)
    return pack ? cleanSpaces(text) : escapeReturn(text)
  }
})

export default function createTreeBuilder(data, options) {
  const root = {
    type: TAG,
    name: '',
    start: 0,
    end: 0,
    nodes: []
  }

  return Object.assign(Object.create(TREE_BUILDER_STRUCT), {
    compact: options.compact !== false,
    prefixes: '?=^',
    state: {
      last: root,
      stack: [],
      scryle: null,
      root,
      style: null,
      script: null,
      data
    }
  })
}
