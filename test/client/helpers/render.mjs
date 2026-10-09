/**
 * A tiny element-tree renderer for the hook harness in `bundle.mjs`.
 *
 * It is deliberately NOT React and NOT react-dom: it walks the element
 * descriptors the bundle's `jsx`/`jsxs` calls produce, gives every function
 * component its own hook context (keyed by element path), and runs the effects
 * the harness collected. That is enough to execute the real render path — the
 * place where a typo would otherwise only surface in the browser — and to read
 * back the resulting attributes, copy, and inline styles.
 */
import { createReactStub } from './bundle.mjs'

/**
 * @param {object} harness - `createReactStub()` result from `loadBundle`.
 * @param {Function} Component - the root function component.
 * @param {object} [initialProps] - props for the root render.
 * @param {string} [rootPath] - hook-context key for the root; pass a distinct
 *   value to mount a second component from the same harness (e.g. the pill and
 *   the queue banner side by side, exactly as the shell renders them).
 */
export function createTreeRenderer(harness, Component, initialProps = {}, rootPath = 'root') {
  const { react, runtime, runEffects, unmount: unmountHarness } = harness
  let tree = null
  let props = initialProps
  let unmounted = false

  const step = (element, path) => {
    if (element === null || element === undefined) return null
    if (typeof element !== 'object') return element
    const children = element.props?.children
    const renderedChildren = renderList(children, path)
    return { type: element.type, props: { ...element.props, children: renderedChildren }, key: element.key ?? null }
  }

  const renderList = (children, path) => {
    if (children === undefined || children === null) return children
    if (!Array.isArray(children)) return renderChild(children, `${path}/0`)
    return children.map((child, index) => renderChild(child, `${path}/${index}`))
  }

  const renderChild = (child, path) => {
    if (child === null || child === undefined) return null
    if (typeof child !== 'object') return child
    if (typeof child.type === 'function') return renderComponent(child.type, child.props, `${path}:${String(child.key ?? '')}`)
    return step(child, path)
  }

  const renderComponent = (type, componentProps, path) => {
    react.__enter(path)
    const element = type(componentProps ?? {})
    if (element === null || element === undefined) return null
    return step(element, path)
  }

  const render = (nextProps) => {
    if (nextProps !== undefined) props = nextProps
    tree = renderComponent(Component, props, rootPath)
    runEffects()
    return tree
  }

  const walk = (node, visit) => {
    if (node === null || node === undefined) return
    if (typeof node !== 'object') return
    visit(node)
    const children = node.props?.children
    if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
    else if (children !== undefined && children !== null) walk(children, visit)
  }

  /** Every element in document order. */
  const all = () => {
    const nodes = []
    walk(tree, (node) => nodes.push(node))
    return nodes
  }

  /** Elements matching a predicate over the descriptor. */
  const findAll = (predicate) => all().filter(predicate)

  /** The first element matching a predicate, or undefined. */
  const find = (predicate) => findAll(predicate)[0]

  /** Elements carrying `props[attribute] === value`. */
  const findAllByAttr = (attribute, value) =>
    findAll((node) => (value === undefined ? node.props?.[attribute] !== undefined : node.props?.[attribute] === value))

  /** The first element carrying `props[attribute] === value`. */
  const findByAttr = (attribute, value) => findAllByAttr(attribute, value)[0]

  /** Elements whose own props contain the given text. */
  const findByText = (text) => find((node) => node.props?.children === text)

  /** Every string child in the tree, joined. */
  const text = () => {
    const parts = []
    walk(tree, (node) => {
      const children = node.props?.children
      const list = Array.isArray(children) ? children : [children]
      for (const child of list) if (typeof child === 'string') parts.push(child)
    })
    return parts.join('')
  }

  /** Invoke a handler with a synthetic event, then re-render. */
  const fire = (node, handler, event = {}) => {
    const fn = node?.props?.[handler]
    if (typeof fn !== 'function') throw new Error(`element has no ${handler} handler`)
    fn(event)
    return render()
  }

  /** Unmount: run every effect cleanup through the harness. */
  const unmount = () => {
    unmounted = true
    unmountHarness()
  }

  return {
    render,
    all,
    find,
    findAll,
    findByAttr,
    findAllByAttr,
    findByText,
    text,
    fire,
    unmount,
    get tree() {
      return tree
    },
    get unmounted() {
      return unmounted
    },
    get renders() {
      return runtime.renders
    },
    get stateUpdates() {
      return runtime.stateUpdates
    },
  }
}

/** Re-export so render tests import one module. */
export { createReactStub }
