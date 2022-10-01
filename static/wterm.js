var wte = (function () {
    'use strict';

    function noop() { }
    function add_location(element, file, line, column, char) {
        element.__svelte_meta = {
            loc: { file, line, column, char }
        };
    }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }
    function action_destroyer(action_result) {
        return action_result && is_function(action_result.destroy) ? action_result.destroy : noop;
    }
    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        node.parentNode.removeChild(node);
    }
    function destroy_each(iterations, detaching) {
        for (let i = 0; i < iterations.length; i += 1) {
            if (iterations[i])
                iterations[i].d(detaching);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function svg_element(name) {
        return document.createElementNS('http://www.w3.org/2000/svg', name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function empty() {
        return text('');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_input_value(input, value) {
        input.value = value == null ? '' : value;
    }
    function set_style(node, key, value, important) {
        if (value === null) {
            node.style.removeProperty(key);
        }
        else {
            node.style.setProperty(key, value, important ? 'important' : '');
        }
    }
    function select_option(select, value) {
        for (let i = 0; i < select.options.length; i += 1) {
            const option = select.options[i];
            if (option.__value === value) {
                option.selected = true;
                return;
            }
        }
        select.selectedIndex = -1; // no option should be selected
    }
    function select_value(select) {
        const selected_option = select.querySelector(':checked') || select.options[0];
        return selected_option && selected_option.__value;
    }
    function toggle_class(element, name, toggle) {
        element.classList[toggle ? 'add' : 'remove'](name);
    }
    function custom_event(type, detail, { bubbles = false, cancelable = false } = {}) {
        const e = document.createEvent('CustomEvent');
        e.initCustomEvent(type, bubbles, cancelable, detail);
        return e;
    }
    class HtmlTag {
        constructor(is_svg = false) {
            this.is_svg = false;
            this.is_svg = is_svg;
            this.e = this.n = null;
        }
        c(html) {
            this.h(html);
        }
        m(html, target, anchor = null) {
            if (!this.e) {
                if (this.is_svg)
                    this.e = svg_element(target.nodeName);
                else
                    this.e = element(target.nodeName);
                this.t = target;
                this.c(html);
            }
            this.i(anchor);
        }
        h(html) {
            this.e.innerHTML = html;
            this.n = Array.from(this.e.childNodes);
        }
        i(anchor) {
            for (let i = 0; i < this.n.length; i += 1) {
                insert(this.t, this.n[i], anchor);
            }
        }
        p(html) {
            this.d();
            this.h(html);
            this.i(this.a);
        }
        d() {
            this.n.forEach(detach);
        }
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }
    function get_current_component() {
        if (!current_component)
            throw new Error('Function called outside component initialization');
        return current_component;
    }
    function onMount(fn) {
        get_current_component().$$.on_mount.push(fn);
    }
    function afterUpdate(fn) {
        get_current_component().$$.after_update.push(fn);
    }
    function createEventDispatcher() {
        const component = get_current_component();
        return (type, detail, { cancelable = false } = {}) => {
            const callbacks = component.$$.callbacks[type];
            if (callbacks) {
                // TODO are there situations where events could be dispatched
                // in a server (non-DOM) environment?
                const event = custom_event(type, detail, { cancelable });
                callbacks.slice().forEach(fn => {
                    fn.call(component, event);
                });
                return !event.defaultPrevented;
            }
            return true;
        };
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    // flush() calls callbacks in this order:
    // 1. All beforeUpdate callbacks, in order: parents before children
    // 2. All bind:this callbacks, in reverse order: children before parents.
    // 3. All afterUpdate callbacks, in order: parents before children. EXCEPT
    //    for afterUpdates called during the initial onMount, which are called in
    //    reverse order: children before parents.
    // Since callbacks might update component values, which could trigger another
    // call to flush(), the following steps guard against this:
    // 1. During beforeUpdate, any updated components will be added to the
    //    dirty_components array and will cause a reentrant call to flush(). Because
    //    the flush index is kept outside the function, the reentrant call will pick
    //    up where the earlier call left off and go through all dirty components. The
    //    current_component value is saved and restored so that the reentrant call will
    //    not interfere with the "parent" flush() call.
    // 2. bind:this callbacks cannot trigger new flush() calls.
    // 3. During afterUpdate, any updated components will NOT have their afterUpdate
    //    callback called a second time; the seen_callbacks set, outside the flush()
    //    function, guarantees this behavior.
    const seen_callbacks = new Set();
    let flushidx = 0; // Do *not* move this inside the flush() function
    function flush() {
        const saved_component = current_component;
        do {
            // first, call beforeUpdate functions
            // and update components
            while (flushidx < dirty_components.length) {
                const component = dirty_components[flushidx];
                flushidx++;
                set_current_component(component);
                update(component.$$);
            }
            set_current_component(null);
            dirty_components.length = 0;
            flushidx = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        seen_callbacks.clear();
        set_current_component(saved_component);
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    const outroing = new Set();
    let outros;
    function group_outros() {
        outros = {
            r: 0,
            c: [],
            p: outros // parent group
        };
    }
    function check_outros() {
        if (!outros.r) {
            run_all(outros.c);
        }
        outros = outros.p;
    }
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function transition_out(block, local, detach, callback) {
        if (block && block.o) {
            if (outroing.has(block))
                return;
            outroing.add(block);
            outros.c.push(() => {
                outroing.delete(block);
                if (callback) {
                    if (detach)
                        block.d(1);
                    callback();
                }
            });
            block.o(local);
        }
        else if (callback) {
            callback();
        }
    }

    const globals = (typeof window !== 'undefined'
        ? window
        : typeof globalThis !== 'undefined'
            ? globalThis
            : global);
    function create_component(block) {
        block && block.c();
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, on_mount, on_destroy, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = on_mount.map(run).filter(is_function);
                if (on_destroy) {
                    on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, append_styles, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: null,
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(options.context || (parent_component ? parent_component.$$.context : [])),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false,
            root: options.target || parent_component.$$.root
        };
        append_styles && append_styles($$.root);
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            flush();
        }
        set_current_component(parent_component);
    }
    /**
     * Base class for Svelte components. Used when dev=false.
     */
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set($$props) {
            if (this.$$set && !is_empty($$props)) {
                this.$$.skip_bound = true;
                this.$$set($$props);
                this.$$.skip_bound = false;
            }
        }
    }

    function dispatch_dev(type, detail) {
        document.dispatchEvent(custom_event(type, Object.assign({ version: '3.49.0' }, detail), { bubbles: true }));
    }
    function append_dev(target, node) {
        dispatch_dev('SvelteDOMInsert', { target, node });
        append(target, node);
    }
    function insert_dev(target, node, anchor) {
        dispatch_dev('SvelteDOMInsert', { target, node, anchor });
        insert(target, node, anchor);
    }
    function detach_dev(node) {
        dispatch_dev('SvelteDOMRemove', { node });
        detach(node);
    }
    function listen_dev(node, event, handler, options, has_prevent_default, has_stop_propagation) {
        const modifiers = options === true ? ['capture'] : options ? Array.from(Object.keys(options)) : [];
        if (has_prevent_default)
            modifiers.push('preventDefault');
        if (has_stop_propagation)
            modifiers.push('stopPropagation');
        dispatch_dev('SvelteDOMAddEventListener', { node, event, handler, modifiers });
        const dispose = listen(node, event, handler, options);
        return () => {
            dispatch_dev('SvelteDOMRemoveEventListener', { node, event, handler, modifiers });
            dispose();
        };
    }
    function attr_dev(node, attribute, value) {
        attr(node, attribute, value);
        if (value == null)
            dispatch_dev('SvelteDOMRemoveAttribute', { node, attribute });
        else
            dispatch_dev('SvelteDOMSetAttribute', { node, attribute, value });
    }
    function prop_dev(node, property, value) {
        node[property] = value;
        dispatch_dev('SvelteDOMSetProperty', { node, property, value });
    }
    function set_data_dev(text, data) {
        data = '' + data;
        if (text.wholeText === data)
            return;
        dispatch_dev('SvelteDOMSetData', { node: text, data });
        text.data = data;
    }
    function validate_each_argument(arg) {
        if (typeof arg !== 'string' && !(arg && typeof arg === 'object' && 'length' in arg)) {
            let msg = '{#each} only iterates over array-like objects.';
            if (typeof Symbol === 'function' && arg && Symbol.iterator in arg) {
                msg += ' You can use a spread to convert this iterable into an array.';
            }
            throw new Error(msg);
        }
    }
    function validate_slots(name, slot, keys) {
        for (const slot_key of Object.keys(slot)) {
            if (!~keys.indexOf(slot_key)) {
                console.warn(`<${name}> received an unexpected slot "${slot_key}".`);
            }
        }
    }
    /**
     * Base class for Svelte components with some minor dev-enhancements. Used when dev=true.
     */
    class SvelteComponentDev extends SvelteComponent {
        constructor(options) {
            if (!options || (!options.target && !options.$$inline)) {
                throw new Error("'target' is a required option");
            }
            super();
        }
        $destroy() {
            super.$destroy();
            this.$destroy = () => {
                console.warn('Component was already destroyed'); // eslint-disable-line no-console
            };
        }
        $capture_state() { }
        $inject_state() { }
    }

    function styleInject(css, ref) {
      if ( ref === void 0 ) ref = {};
      var insertAt = ref.insertAt;

      if (!css || typeof document === 'undefined') { return; }

      var head = document.head || document.getElementsByTagName('head')[0];
      var style = document.createElement('style');
      style.type = 'text/css';

      if (insertAt === 'top') {
        if (head.firstChild) {
          head.insertBefore(style, head.firstChild);
        } else {
          head.appendChild(style);
        }
      } else {
        head.appendChild(style);
      }

      if (style.styleSheet) {
        style.styleSheet.cssText = css;
      } else {
        style.appendChild(document.createTextNode(css));
      }
    }

    var css_248z$5 = "/**\n * Copyright (c) 2014 The xterm.js authors. All rights reserved.\n * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)\n * https://github.com/chjj/term.js\n * @license MIT\n *\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n * of this software and associated documentation files (the \"Software\"), to deal\n * in the Software without restriction, including without limitation the rights\n * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n * copies of the Software, and to permit persons to whom the Software is\n * furnished to do so, subject to the following conditions:\n *\n * The above copyright notice and this permission notice shall be included in\n * all copies or substantial portions of the Software.\n *\n * THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\n * THE SOFTWARE.\n *\n * Originally forked from (with the author's permission):\n *   Fabrice Bellard's javascript vt100 for jslinux:\n *   http://bellard.org/jslinux/\n *   Copyright (c) 2011 Fabrice Bellard\n *   The original design remains. The terminal itself\n *   has been extended to include xterm CSI codes, among\n *   other features.\n */\n\n/**\n *  Default styles for xterm.js\n */\n\n.xterm {\n    cursor: text;\n    position: relative;\n    user-select: none;\n    -ms-user-select: none;\n    -webkit-user-select: none;\n}\n\n.xterm.focus,\n.xterm:focus {\n    outline: none;\n}\n\n.xterm .xterm-helpers {\n    position: absolute;\n    top: 0;\n    /**\n     * The z-index of the helpers must be higher than the canvases in order for\n     * IMEs to appear on top.\n     */\n    z-index: 5;\n}\n\n.xterm .xterm-helper-textarea {\n    padding: 0;\n    border: 0;\n    margin: 0;\n    /* Move textarea out of the screen to the far left, so that the cursor is not visible */\n    position: absolute;\n    opacity: 0;\n    left: -9999em;\n    top: 0;\n    width: 0;\n    height: 0;\n    z-index: -5;\n    /** Prevent wrapping so the IME appears against the textarea at the correct position */\n    white-space: nowrap;\n    overflow: hidden;\n    resize: none;\n}\n\n.xterm .composition-view {\n    /* TODO: Composition position got messed up somewhere */\n    background: #000;\n    color: #FFF;\n    display: none;\n    position: absolute;\n    white-space: nowrap;\n    z-index: 1;\n}\n\n.xterm .composition-view.active {\n    display: block;\n}\n\n.xterm .xterm-viewport {\n    /* On OS X this is required in order for the scroll bar to appear fully opaque */\n    background-color: #000;\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n}\n\n.xterm .xterm-screen {\n    position: relative;\n}\n\n.xterm .xterm-screen canvas {\n    position: absolute;\n    left: 0;\n    top: 0;\n}\n\n.xterm .xterm-scroll-area {\n    visibility: hidden;\n}\n\n.xterm-char-measure-element {\n    display: inline-block;\n    visibility: hidden;\n    position: absolute;\n    top: 0;\n    left: -9999em;\n    line-height: normal;\n}\n\n.xterm.enable-mouse-events {\n    /* When mouse events are enabled (eg. tmux), revert to the standard pointer cursor */\n    cursor: default;\n}\n\n.xterm.xterm-cursor-pointer,\n.xterm .xterm-cursor-pointer {\n    cursor: pointer;\n}\n\n.xterm.column-select.focus {\n    /* Column selection mode */\n    cursor: crosshair;\n}\n\n.xterm .xterm-accessibility,\n.xterm .xterm-message {\n    position: absolute;\n    left: 0;\n    top: 0;\n    bottom: 0;\n    right: 0;\n    z-index: 10;\n    color: transparent;\n}\n\n.xterm .live-region {\n    position: absolute;\n    left: -9999px;\n    width: 1px;\n    height: 1px;\n    overflow: hidden;\n}\n\n.xterm-dim {\n    opacity: 0.5;\n}\n\n.xterm-underline {\n    text-decoration: underline;\n}\n\n.xterm-strikethrough {\n    text-decoration: line-through;\n}\n\n.xterm-screen .xterm-decoration-container .xterm-decoration {\n\tz-index: 6;\n\tposition: absolute;\n}\n\n.xterm-decoration-overview-ruler {\n    z-index: 7;\n    position: absolute;\n    top: 0;\n    right: 0;\n    pointer-events: none;\n}\n\n.xterm-decoration-top {\n    z-index: 2;\n    position: relative;\n}\n";
    styleInject(css_248z$5);

    var css_248z$4 = "/*! bulma.io v0.9.4 | MIT License | github.com/jgthms/bulma */.button,.file-cta,.file-name,.input,.pagination-ellipsis,.pagination-link,.pagination-next,.pagination-previous,.select select,.textarea{-moz-appearance:none;-webkit-appearance:none;align-items:center;border:1px solid transparent;border-radius:4px;box-shadow:none;display:inline-flex;font-size:1rem;height:2.5em;justify-content:flex-start;line-height:1.5;padding-bottom:calc(.5em - 1px);padding-left:calc(.75em - 1px);padding-right:calc(.75em - 1px);padding-top:calc(.5em - 1px);position:relative;vertical-align:top}.button:active,.button:focus,.file-cta:active,.file-cta:focus,.file-name:active,.file-name:focus,.input:active,.input:focus,.is-active.button,.is-active.file-cta,.is-active.file-name,.is-active.input,.is-active.pagination-ellipsis,.is-active.pagination-link,.is-active.pagination-next,.is-active.pagination-previous,.is-active.textarea,.is-focused.button,.is-focused.file-cta,.is-focused.file-name,.is-focused.input,.is-focused.pagination-ellipsis,.is-focused.pagination-link,.is-focused.pagination-next,.is-focused.pagination-previous,.is-focused.textarea,.pagination-ellipsis:active,.pagination-ellipsis:focus,.pagination-link:active,.pagination-link:focus,.pagination-next:active,.pagination-next:focus,.pagination-previous:active,.pagination-previous:focus,.select select.is-active,.select select.is-focused,.select select:active,.select select:focus,.textarea:active,.textarea:focus{outline:0}.button[disabled],.file-cta[disabled],.file-name[disabled],.input[disabled],.pagination-ellipsis[disabled],.pagination-link[disabled],.pagination-next[disabled],.pagination-previous[disabled],.select fieldset[disabled] select,.select select[disabled],.textarea[disabled],fieldset[disabled] .button,fieldset[disabled] .file-cta,fieldset[disabled] .file-name,fieldset[disabled] .input,fieldset[disabled] .pagination-ellipsis,fieldset[disabled] .pagination-link,fieldset[disabled] .pagination-next,fieldset[disabled] .pagination-previous,fieldset[disabled] .select select,fieldset[disabled] .textarea{cursor:not-allowed}.breadcrumb,.button,.file,.is-unselectable,.pagination-ellipsis,.pagination-link,.pagination-next,.pagination-previous,.tabs{-webkit-touch-callout:none;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none}.navbar-link:not(.is-arrowless)::after,.select:not(.is-multiple):not(.is-loading)::after{border:3px solid transparent;border-radius:2px;border-right:0;border-top:0;content:\" \";display:block;height:.625em;margin-top:-.4375em;pointer-events:none;position:absolute;top:50%;transform:rotate(-45deg);transform-origin:center;width:.625em}.block:not(:last-child),.box:not(:last-child),.breadcrumb:not(:last-child),.content:not(:last-child),.level:not(:last-child),.message:not(:last-child),.notification:not(:last-child),.pagination:not(:last-child),.progress:not(:last-child),.subtitle:not(:last-child),.table-container:not(:last-child),.table:not(:last-child),.tabs:not(:last-child),.title:not(:last-child){margin-bottom:1.5rem}.delete,.modal-close{-webkit-touch-callout:none;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;-moz-appearance:none;-webkit-appearance:none;background-color:rgba(10,10,10,.2);border:none;border-radius:9999px;cursor:pointer;pointer-events:auto;display:inline-block;flex-grow:0;flex-shrink:0;font-size:0;height:20px;max-height:20px;max-width:20px;min-height:20px;min-width:20px;outline:0;position:relative;vertical-align:top;width:20px}.delete::after,.delete::before,.modal-close::after,.modal-close::before{background-color:#fff;content:\"\";display:block;left:50%;position:absolute;top:50%;transform:translateX(-50%) translateY(-50%) rotate(45deg);transform-origin:center center}.delete::before,.modal-close::before{height:2px;width:50%}.delete::after,.modal-close::after{height:50%;width:2px}.delete:focus,.delete:hover,.modal-close:focus,.modal-close:hover{background-color:rgba(10,10,10,.3)}.delete:active,.modal-close:active{background-color:rgba(10,10,10,.4)}.is-small.delete,.is-small.modal-close{height:16px;max-height:16px;max-width:16px;min-height:16px;min-width:16px;width:16px}.is-medium.delete,.is-medium.modal-close{height:24px;max-height:24px;max-width:24px;min-height:24px;min-width:24px;width:24px}.is-large.delete,.is-large.modal-close{height:32px;max-height:32px;max-width:32px;min-height:32px;min-width:32px;width:32px}.button.is-loading::after,.control.is-loading::after,.loader,.select.is-loading::after{-webkit-animation:spinAround .5s infinite linear;animation:spinAround .5s infinite linear;border:2px solid #dbdbdb;border-radius:9999px;border-right-color:transparent;border-top-color:transparent;content:\"\";display:block;height:1em;position:relative;width:1em}.hero-video,.image.is-16by9 .has-ratio,.image.is-16by9 img,.image.is-1by1 .has-ratio,.image.is-1by1 img,.image.is-1by2 .has-ratio,.image.is-1by2 img,.image.is-1by3 .has-ratio,.image.is-1by3 img,.image.is-2by1 .has-ratio,.image.is-2by1 img,.image.is-2by3 .has-ratio,.image.is-2by3 img,.image.is-3by1 .has-ratio,.image.is-3by1 img,.image.is-3by2 .has-ratio,.image.is-3by2 img,.image.is-3by4 .has-ratio,.image.is-3by4 img,.image.is-3by5 .has-ratio,.image.is-3by5 img,.image.is-4by3 .has-ratio,.image.is-4by3 img,.image.is-4by5 .has-ratio,.image.is-4by5 img,.image.is-5by3 .has-ratio,.image.is-5by3 img,.image.is-5by4 .has-ratio,.image.is-5by4 img,.image.is-9by16 .has-ratio,.image.is-9by16 img,.image.is-square .has-ratio,.image.is-square img,.is-overlay,.modal,.modal-background{bottom:0;left:0;position:absolute;right:0;top:0}.navbar-burger{-moz-appearance:none;-webkit-appearance:none;appearance:none;background:0 0;border:none;color:currentColor;font-family:inherit;font-size:1em;margin:0;padding:0}/*! minireset.css v0.0.6 | MIT License | github.com/jgthms/minireset.css */blockquote,body,dd,dl,dt,fieldset,figure,h1,h2,h3,h4,h5,h6,hr,html,iframe,legend,li,ol,p,pre,textarea,ul{margin:0;padding:0}h1,h2,h3,h4,h5,h6{font-size:100%;font-weight:400}ul{list-style:none}button,input,select,textarea{margin:0}html{box-sizing:border-box}*,::after,::before{box-sizing:inherit}img,video{height:auto;max-width:100%}iframe{border:0}table{border-collapse:collapse;border-spacing:0}td,th{padding:0}td:not([align]),th:not([align]){text-align:inherit}html{background-color:#fff;font-size:16px;-moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased;min-width:300px;overflow-x:hidden;overflow-y:scroll;text-rendering:optimizeLegibility;-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%}article,aside,figure,footer,header,hgroup,section{display:block}body,button,input,optgroup,select,textarea{font-family:BlinkMacSystemFont,-apple-system,\"Segoe UI\",Roboto,Oxygen,Ubuntu,Cantarell,\"Fira Sans\",\"Droid Sans\",\"Helvetica Neue\",Helvetica,Arial,sans-serif}code,pre{-moz-osx-font-smoothing:auto;-webkit-font-smoothing:auto;font-family:monospace}body{color:#4a4a4a;font-size:1em;font-weight:400;line-height:1.5}a{color:#485fc7;cursor:pointer;text-decoration:none}a strong{color:currentColor}a:hover{color:#363636}code{background-color:#f5f5f5;color:#da1039;font-size:.875em;font-weight:400;padding:.25em .5em .25em}hr{background-color:#f5f5f5;border:none;display:block;height:2px;margin:1.5rem 0}img{height:auto;max-width:100%}input[type=checkbox],input[type=radio]{vertical-align:baseline}small{font-size:.875em}span{font-style:inherit;font-weight:inherit}strong{color:#363636;font-weight:700}fieldset{border:none}pre{-webkit-overflow-scrolling:touch;background-color:#f5f5f5;color:#4a4a4a;font-size:.875em;overflow-x:auto;padding:1.25rem 1.5rem;white-space:pre;word-wrap:normal}pre code{background-color:transparent;color:currentColor;font-size:1em;padding:0}table td,table th{vertical-align:top}table td:not([align]),table th:not([align]){text-align:inherit}table th{color:#363636}@-webkit-keyframes spinAround{from{transform:rotate(0)}to{transform:rotate(359deg)}}@keyframes spinAround{from{transform:rotate(0)}to{transform:rotate(359deg)}}.box{background-color:#fff;border-radius:6px;box-shadow:0 .5em 1em -.125em rgba(10,10,10,.1),0 0 0 1px rgba(10,10,10,.02);color:#4a4a4a;display:block;padding:1.25rem}a.box:focus,a.box:hover{box-shadow:0 .5em 1em -.125em rgba(10,10,10,.1),0 0 0 1px #485fc7}a.box:active{box-shadow:inset 0 1px 2px rgba(10,10,10,.2),0 0 0 1px #485fc7}.button{background-color:#fff;border-color:#dbdbdb;border-width:1px;color:#363636;cursor:pointer;justify-content:center;padding-bottom:calc(.5em - 1px);padding-left:1em;padding-right:1em;padding-top:calc(.5em - 1px);text-align:center;white-space:nowrap}.button strong{color:inherit}.button .icon,.button .icon.is-large,.button .icon.is-medium,.button .icon.is-small{height:1.5em;width:1.5em}.button .icon:first-child:not(:last-child){margin-left:calc(-.5em - 1px);margin-right:.25em}.button .icon:last-child:not(:first-child){margin-left:.25em;margin-right:calc(-.5em - 1px)}.button .icon:first-child:last-child{margin-left:calc(-.5em - 1px);margin-right:calc(-.5em - 1px)}.button.is-hovered,.button:hover{border-color:#b5b5b5;color:#363636}.button.is-focused,.button:focus{border-color:#485fc7;color:#363636}.button.is-focused:not(:active),.button:focus:not(:active){box-shadow:0 0 0 .125em rgba(72,95,199,.25)}.button.is-active,.button:active{border-color:#4a4a4a;color:#363636}.button.is-text{background-color:transparent;border-color:transparent;color:#4a4a4a;text-decoration:underline}.button.is-text.is-focused,.button.is-text.is-hovered,.button.is-text:focus,.button.is-text:hover{background-color:#f5f5f5;color:#363636}.button.is-text.is-active,.button.is-text:active{background-color:#e8e8e8;color:#363636}.button.is-text[disabled],fieldset[disabled] .button.is-text{background-color:transparent;border-color:transparent;box-shadow:none}.button.is-ghost{background:0 0;border-color:transparent;color:#485fc7;text-decoration:none}.button.is-ghost.is-hovered,.button.is-ghost:hover{color:#485fc7;text-decoration:underline}.button.is-white{background-color:#fff;border-color:transparent;color:#0a0a0a}.button.is-white.is-hovered,.button.is-white:hover{background-color:#f9f9f9;border-color:transparent;color:#0a0a0a}.button.is-white.is-focused,.button.is-white:focus{border-color:transparent;color:#0a0a0a}.button.is-white.is-focused:not(:active),.button.is-white:focus:not(:active){box-shadow:0 0 0 .125em rgba(255,255,255,.25)}.button.is-white.is-active,.button.is-white:active{background-color:#f2f2f2;border-color:transparent;color:#0a0a0a}.button.is-white[disabled],fieldset[disabled] .button.is-white{background-color:#fff;border-color:#fff;box-shadow:none}.button.is-white.is-inverted{background-color:#0a0a0a;color:#fff}.button.is-white.is-inverted.is-hovered,.button.is-white.is-inverted:hover{background-color:#000}.button.is-white.is-inverted[disabled],fieldset[disabled] .button.is-white.is-inverted{background-color:#0a0a0a;border-color:transparent;box-shadow:none;color:#fff}.button.is-white.is-loading::after{border-color:transparent transparent #0a0a0a #0a0a0a!important}.button.is-white.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-white.is-outlined.is-focused,.button.is-white.is-outlined.is-hovered,.button.is-white.is-outlined:focus,.button.is-white.is-outlined:hover{background-color:#fff;border-color:#fff;color:#0a0a0a}.button.is-white.is-outlined.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-white.is-outlined.is-loading.is-focused::after,.button.is-white.is-outlined.is-loading.is-hovered::after,.button.is-white.is-outlined.is-loading:focus::after,.button.is-white.is-outlined.is-loading:hover::after{border-color:transparent transparent #0a0a0a #0a0a0a!important}.button.is-white.is-outlined[disabled],fieldset[disabled] .button.is-white.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-white.is-inverted.is-outlined{background-color:transparent;border-color:#0a0a0a;color:#0a0a0a}.button.is-white.is-inverted.is-outlined.is-focused,.button.is-white.is-inverted.is-outlined.is-hovered,.button.is-white.is-inverted.is-outlined:focus,.button.is-white.is-inverted.is-outlined:hover{background-color:#0a0a0a;color:#fff}.button.is-white.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-white.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-white.is-inverted.is-outlined.is-loading:focus::after,.button.is-white.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-white.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-white.is-inverted.is-outlined{background-color:transparent;border-color:#0a0a0a;box-shadow:none;color:#0a0a0a}.button.is-black{background-color:#0a0a0a;border-color:transparent;color:#fff}.button.is-black.is-hovered,.button.is-black:hover{background-color:#040404;border-color:transparent;color:#fff}.button.is-black.is-focused,.button.is-black:focus{border-color:transparent;color:#fff}.button.is-black.is-focused:not(:active),.button.is-black:focus:not(:active){box-shadow:0 0 0 .125em rgba(10,10,10,.25)}.button.is-black.is-active,.button.is-black:active{background-color:#000;border-color:transparent;color:#fff}.button.is-black[disabled],fieldset[disabled] .button.is-black{background-color:#0a0a0a;border-color:#0a0a0a;box-shadow:none}.button.is-black.is-inverted{background-color:#fff;color:#0a0a0a}.button.is-black.is-inverted.is-hovered,.button.is-black.is-inverted:hover{background-color:#f2f2f2}.button.is-black.is-inverted[disabled],fieldset[disabled] .button.is-black.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#0a0a0a}.button.is-black.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-black.is-outlined{background-color:transparent;border-color:#0a0a0a;color:#0a0a0a}.button.is-black.is-outlined.is-focused,.button.is-black.is-outlined.is-hovered,.button.is-black.is-outlined:focus,.button.is-black.is-outlined:hover{background-color:#0a0a0a;border-color:#0a0a0a;color:#fff}.button.is-black.is-outlined.is-loading::after{border-color:transparent transparent #0a0a0a #0a0a0a!important}.button.is-black.is-outlined.is-loading.is-focused::after,.button.is-black.is-outlined.is-loading.is-hovered::after,.button.is-black.is-outlined.is-loading:focus::after,.button.is-black.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-black.is-outlined[disabled],fieldset[disabled] .button.is-black.is-outlined{background-color:transparent;border-color:#0a0a0a;box-shadow:none;color:#0a0a0a}.button.is-black.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-black.is-inverted.is-outlined.is-focused,.button.is-black.is-inverted.is-outlined.is-hovered,.button.is-black.is-inverted.is-outlined:focus,.button.is-black.is-inverted.is-outlined:hover{background-color:#fff;color:#0a0a0a}.button.is-black.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-black.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-black.is-inverted.is-outlined.is-loading:focus::after,.button.is-black.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #0a0a0a #0a0a0a!important}.button.is-black.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-black.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-light{background-color:#f5f5f5;border-color:transparent;color:rgba(0,0,0,.7)}.button.is-light.is-hovered,.button.is-light:hover{background-color:#eee;border-color:transparent;color:rgba(0,0,0,.7)}.button.is-light.is-focused,.button.is-light:focus{border-color:transparent;color:rgba(0,0,0,.7)}.button.is-light.is-focused:not(:active),.button.is-light:focus:not(:active){box-shadow:0 0 0 .125em rgba(245,245,245,.25)}.button.is-light.is-active,.button.is-light:active{background-color:#e8e8e8;border-color:transparent;color:rgba(0,0,0,.7)}.button.is-light[disabled],fieldset[disabled] .button.is-light{background-color:#f5f5f5;border-color:#f5f5f5;box-shadow:none}.button.is-light.is-inverted{background-color:rgba(0,0,0,.7);color:#f5f5f5}.button.is-light.is-inverted.is-hovered,.button.is-light.is-inverted:hover{background-color:rgba(0,0,0,.7)}.button.is-light.is-inverted[disabled],fieldset[disabled] .button.is-light.is-inverted{background-color:rgba(0,0,0,.7);border-color:transparent;box-shadow:none;color:#f5f5f5}.button.is-light.is-loading::after{border-color:transparent transparent rgba(0,0,0,.7) rgba(0,0,0,.7)!important}.button.is-light.is-outlined{background-color:transparent;border-color:#f5f5f5;color:#f5f5f5}.button.is-light.is-outlined.is-focused,.button.is-light.is-outlined.is-hovered,.button.is-light.is-outlined:focus,.button.is-light.is-outlined:hover{background-color:#f5f5f5;border-color:#f5f5f5;color:rgba(0,0,0,.7)}.button.is-light.is-outlined.is-loading::after{border-color:transparent transparent #f5f5f5 #f5f5f5!important}.button.is-light.is-outlined.is-loading.is-focused::after,.button.is-light.is-outlined.is-loading.is-hovered::after,.button.is-light.is-outlined.is-loading:focus::after,.button.is-light.is-outlined.is-loading:hover::after{border-color:transparent transparent rgba(0,0,0,.7) rgba(0,0,0,.7)!important}.button.is-light.is-outlined[disabled],fieldset[disabled] .button.is-light.is-outlined{background-color:transparent;border-color:#f5f5f5;box-shadow:none;color:#f5f5f5}.button.is-light.is-inverted.is-outlined{background-color:transparent;border-color:rgba(0,0,0,.7);color:rgba(0,0,0,.7)}.button.is-light.is-inverted.is-outlined.is-focused,.button.is-light.is-inverted.is-outlined.is-hovered,.button.is-light.is-inverted.is-outlined:focus,.button.is-light.is-inverted.is-outlined:hover{background-color:rgba(0,0,0,.7);color:#f5f5f5}.button.is-light.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-light.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-light.is-inverted.is-outlined.is-loading:focus::after,.button.is-light.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #f5f5f5 #f5f5f5!important}.button.is-light.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-light.is-inverted.is-outlined{background-color:transparent;border-color:rgba(0,0,0,.7);box-shadow:none;color:rgba(0,0,0,.7)}.button.is-dark{background-color:#363636;border-color:transparent;color:#fff}.button.is-dark.is-hovered,.button.is-dark:hover{background-color:#2f2f2f;border-color:transparent;color:#fff}.button.is-dark.is-focused,.button.is-dark:focus{border-color:transparent;color:#fff}.button.is-dark.is-focused:not(:active),.button.is-dark:focus:not(:active){box-shadow:0 0 0 .125em rgba(54,54,54,.25)}.button.is-dark.is-active,.button.is-dark:active{background-color:#292929;border-color:transparent;color:#fff}.button.is-dark[disabled],fieldset[disabled] .button.is-dark{background-color:#363636;border-color:#363636;box-shadow:none}.button.is-dark.is-inverted{background-color:#fff;color:#363636}.button.is-dark.is-inverted.is-hovered,.button.is-dark.is-inverted:hover{background-color:#f2f2f2}.button.is-dark.is-inverted[disabled],fieldset[disabled] .button.is-dark.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#363636}.button.is-dark.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-dark.is-outlined{background-color:transparent;border-color:#363636;color:#363636}.button.is-dark.is-outlined.is-focused,.button.is-dark.is-outlined.is-hovered,.button.is-dark.is-outlined:focus,.button.is-dark.is-outlined:hover{background-color:#363636;border-color:#363636;color:#fff}.button.is-dark.is-outlined.is-loading::after{border-color:transparent transparent #363636 #363636!important}.button.is-dark.is-outlined.is-loading.is-focused::after,.button.is-dark.is-outlined.is-loading.is-hovered::after,.button.is-dark.is-outlined.is-loading:focus::after,.button.is-dark.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-dark.is-outlined[disabled],fieldset[disabled] .button.is-dark.is-outlined{background-color:transparent;border-color:#363636;box-shadow:none;color:#363636}.button.is-dark.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-dark.is-inverted.is-outlined.is-focused,.button.is-dark.is-inverted.is-outlined.is-hovered,.button.is-dark.is-inverted.is-outlined:focus,.button.is-dark.is-inverted.is-outlined:hover{background-color:#fff;color:#363636}.button.is-dark.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-dark.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-dark.is-inverted.is-outlined.is-loading:focus::after,.button.is-dark.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #363636 #363636!important}.button.is-dark.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-dark.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-primary{background-color:#00d1b2;border-color:transparent;color:#fff}.button.is-primary.is-hovered,.button.is-primary:hover{background-color:#00c4a7;border-color:transparent;color:#fff}.button.is-primary.is-focused,.button.is-primary:focus{border-color:transparent;color:#fff}.button.is-primary.is-focused:not(:active),.button.is-primary:focus:not(:active){box-shadow:0 0 0 .125em rgba(0,209,178,.25)}.button.is-primary.is-active,.button.is-primary:active{background-color:#00b89c;border-color:transparent;color:#fff}.button.is-primary[disabled],fieldset[disabled] .button.is-primary{background-color:#00d1b2;border-color:#00d1b2;box-shadow:none}.button.is-primary.is-inverted{background-color:#fff;color:#00d1b2}.button.is-primary.is-inverted.is-hovered,.button.is-primary.is-inverted:hover{background-color:#f2f2f2}.button.is-primary.is-inverted[disabled],fieldset[disabled] .button.is-primary.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#00d1b2}.button.is-primary.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-primary.is-outlined{background-color:transparent;border-color:#00d1b2;color:#00d1b2}.button.is-primary.is-outlined.is-focused,.button.is-primary.is-outlined.is-hovered,.button.is-primary.is-outlined:focus,.button.is-primary.is-outlined:hover{background-color:#00d1b2;border-color:#00d1b2;color:#fff}.button.is-primary.is-outlined.is-loading::after{border-color:transparent transparent #00d1b2 #00d1b2!important}.button.is-primary.is-outlined.is-loading.is-focused::after,.button.is-primary.is-outlined.is-loading.is-hovered::after,.button.is-primary.is-outlined.is-loading:focus::after,.button.is-primary.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-primary.is-outlined[disabled],fieldset[disabled] .button.is-primary.is-outlined{background-color:transparent;border-color:#00d1b2;box-shadow:none;color:#00d1b2}.button.is-primary.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-primary.is-inverted.is-outlined.is-focused,.button.is-primary.is-inverted.is-outlined.is-hovered,.button.is-primary.is-inverted.is-outlined:focus,.button.is-primary.is-inverted.is-outlined:hover{background-color:#fff;color:#00d1b2}.button.is-primary.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-primary.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-primary.is-inverted.is-outlined.is-loading:focus::after,.button.is-primary.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #00d1b2 #00d1b2!important}.button.is-primary.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-primary.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-primary.is-light{background-color:#ebfffc;color:#00947e}.button.is-primary.is-light.is-hovered,.button.is-primary.is-light:hover{background-color:#defffa;border-color:transparent;color:#00947e}.button.is-primary.is-light.is-active,.button.is-primary.is-light:active{background-color:#d1fff8;border-color:transparent;color:#00947e}.button.is-link{background-color:#485fc7;border-color:transparent;color:#fff}.button.is-link.is-hovered,.button.is-link:hover{background-color:#3e56c4;border-color:transparent;color:#fff}.button.is-link.is-focused,.button.is-link:focus{border-color:transparent;color:#fff}.button.is-link.is-focused:not(:active),.button.is-link:focus:not(:active){box-shadow:0 0 0 .125em rgba(72,95,199,.25)}.button.is-link.is-active,.button.is-link:active{background-color:#3a51bb;border-color:transparent;color:#fff}.button.is-link[disabled],fieldset[disabled] .button.is-link{background-color:#485fc7;border-color:#485fc7;box-shadow:none}.button.is-link.is-inverted{background-color:#fff;color:#485fc7}.button.is-link.is-inverted.is-hovered,.button.is-link.is-inverted:hover{background-color:#f2f2f2}.button.is-link.is-inverted[disabled],fieldset[disabled] .button.is-link.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#485fc7}.button.is-link.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-link.is-outlined{background-color:transparent;border-color:#485fc7;color:#485fc7}.button.is-link.is-outlined.is-focused,.button.is-link.is-outlined.is-hovered,.button.is-link.is-outlined:focus,.button.is-link.is-outlined:hover{background-color:#485fc7;border-color:#485fc7;color:#fff}.button.is-link.is-outlined.is-loading::after{border-color:transparent transparent #485fc7 #485fc7!important}.button.is-link.is-outlined.is-loading.is-focused::after,.button.is-link.is-outlined.is-loading.is-hovered::after,.button.is-link.is-outlined.is-loading:focus::after,.button.is-link.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-link.is-outlined[disabled],fieldset[disabled] .button.is-link.is-outlined{background-color:transparent;border-color:#485fc7;box-shadow:none;color:#485fc7}.button.is-link.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-link.is-inverted.is-outlined.is-focused,.button.is-link.is-inverted.is-outlined.is-hovered,.button.is-link.is-inverted.is-outlined:focus,.button.is-link.is-inverted.is-outlined:hover{background-color:#fff;color:#485fc7}.button.is-link.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-link.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-link.is-inverted.is-outlined.is-loading:focus::after,.button.is-link.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #485fc7 #485fc7!important}.button.is-link.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-link.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-link.is-light{background-color:#eff1fa;color:#3850b7}.button.is-link.is-light.is-hovered,.button.is-link.is-light:hover{background-color:#e6e9f7;border-color:transparent;color:#3850b7}.button.is-link.is-light.is-active,.button.is-link.is-light:active{background-color:#dce0f4;border-color:transparent;color:#3850b7}.button.is-info{background-color:#3e8ed0;border-color:transparent;color:#fff}.button.is-info.is-hovered,.button.is-info:hover{background-color:#3488ce;border-color:transparent;color:#fff}.button.is-info.is-focused,.button.is-info:focus{border-color:transparent;color:#fff}.button.is-info.is-focused:not(:active),.button.is-info:focus:not(:active){box-shadow:0 0 0 .125em rgba(62,142,208,.25)}.button.is-info.is-active,.button.is-info:active{background-color:#3082c5;border-color:transparent;color:#fff}.button.is-info[disabled],fieldset[disabled] .button.is-info{background-color:#3e8ed0;border-color:#3e8ed0;box-shadow:none}.button.is-info.is-inverted{background-color:#fff;color:#3e8ed0}.button.is-info.is-inverted.is-hovered,.button.is-info.is-inverted:hover{background-color:#f2f2f2}.button.is-info.is-inverted[disabled],fieldset[disabled] .button.is-info.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#3e8ed0}.button.is-info.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-info.is-outlined{background-color:transparent;border-color:#3e8ed0;color:#3e8ed0}.button.is-info.is-outlined.is-focused,.button.is-info.is-outlined.is-hovered,.button.is-info.is-outlined:focus,.button.is-info.is-outlined:hover{background-color:#3e8ed0;border-color:#3e8ed0;color:#fff}.button.is-info.is-outlined.is-loading::after{border-color:transparent transparent #3e8ed0 #3e8ed0!important}.button.is-info.is-outlined.is-loading.is-focused::after,.button.is-info.is-outlined.is-loading.is-hovered::after,.button.is-info.is-outlined.is-loading:focus::after,.button.is-info.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-info.is-outlined[disabled],fieldset[disabled] .button.is-info.is-outlined{background-color:transparent;border-color:#3e8ed0;box-shadow:none;color:#3e8ed0}.button.is-info.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-info.is-inverted.is-outlined.is-focused,.button.is-info.is-inverted.is-outlined.is-hovered,.button.is-info.is-inverted.is-outlined:focus,.button.is-info.is-inverted.is-outlined:hover{background-color:#fff;color:#3e8ed0}.button.is-info.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-info.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-info.is-inverted.is-outlined.is-loading:focus::after,.button.is-info.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #3e8ed0 #3e8ed0!important}.button.is-info.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-info.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-info.is-light{background-color:#eff5fb;color:#296fa8}.button.is-info.is-light.is-hovered,.button.is-info.is-light:hover{background-color:#e4eff9;border-color:transparent;color:#296fa8}.button.is-info.is-light.is-active,.button.is-info.is-light:active{background-color:#dae9f6;border-color:transparent;color:#296fa8}.button.is-success{background-color:#48c78e;border-color:transparent;color:#fff}.button.is-success.is-hovered,.button.is-success:hover{background-color:#3ec487;border-color:transparent;color:#fff}.button.is-success.is-focused,.button.is-success:focus{border-color:transparent;color:#fff}.button.is-success.is-focused:not(:active),.button.is-success:focus:not(:active){box-shadow:0 0 0 .125em rgba(72,199,142,.25)}.button.is-success.is-active,.button.is-success:active{background-color:#3abb81;border-color:transparent;color:#fff}.button.is-success[disabled],fieldset[disabled] .button.is-success{background-color:#48c78e;border-color:#48c78e;box-shadow:none}.button.is-success.is-inverted{background-color:#fff;color:#48c78e}.button.is-success.is-inverted.is-hovered,.button.is-success.is-inverted:hover{background-color:#f2f2f2}.button.is-success.is-inverted[disabled],fieldset[disabled] .button.is-success.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#48c78e}.button.is-success.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-success.is-outlined{background-color:transparent;border-color:#48c78e;color:#48c78e}.button.is-success.is-outlined.is-focused,.button.is-success.is-outlined.is-hovered,.button.is-success.is-outlined:focus,.button.is-success.is-outlined:hover{background-color:#48c78e;border-color:#48c78e;color:#fff}.button.is-success.is-outlined.is-loading::after{border-color:transparent transparent #48c78e #48c78e!important}.button.is-success.is-outlined.is-loading.is-focused::after,.button.is-success.is-outlined.is-loading.is-hovered::after,.button.is-success.is-outlined.is-loading:focus::after,.button.is-success.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-success.is-outlined[disabled],fieldset[disabled] .button.is-success.is-outlined{background-color:transparent;border-color:#48c78e;box-shadow:none;color:#48c78e}.button.is-success.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-success.is-inverted.is-outlined.is-focused,.button.is-success.is-inverted.is-outlined.is-hovered,.button.is-success.is-inverted.is-outlined:focus,.button.is-success.is-inverted.is-outlined:hover{background-color:#fff;color:#48c78e}.button.is-success.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-success.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-success.is-inverted.is-outlined.is-loading:focus::after,.button.is-success.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #48c78e #48c78e!important}.button.is-success.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-success.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-success.is-light{background-color:#effaf5;color:#257953}.button.is-success.is-light.is-hovered,.button.is-success.is-light:hover{background-color:#e6f7ef;border-color:transparent;color:#257953}.button.is-success.is-light.is-active,.button.is-success.is-light:active{background-color:#dcf4e9;border-color:transparent;color:#257953}.button.is-warning{background-color:#ffe08a;border-color:transparent;color:rgba(0,0,0,.7)}.button.is-warning.is-hovered,.button.is-warning:hover{background-color:#ffdc7d;border-color:transparent;color:rgba(0,0,0,.7)}.button.is-warning.is-focused,.button.is-warning:focus{border-color:transparent;color:rgba(0,0,0,.7)}.button.is-warning.is-focused:not(:active),.button.is-warning:focus:not(:active){box-shadow:0 0 0 .125em rgba(255,224,138,.25)}.button.is-warning.is-active,.button.is-warning:active{background-color:#ffd970;border-color:transparent;color:rgba(0,0,0,.7)}.button.is-warning[disabled],fieldset[disabled] .button.is-warning{background-color:#ffe08a;border-color:#ffe08a;box-shadow:none}.button.is-warning.is-inverted{background-color:rgba(0,0,0,.7);color:#ffe08a}.button.is-warning.is-inverted.is-hovered,.button.is-warning.is-inverted:hover{background-color:rgba(0,0,0,.7)}.button.is-warning.is-inverted[disabled],fieldset[disabled] .button.is-warning.is-inverted{background-color:rgba(0,0,0,.7);border-color:transparent;box-shadow:none;color:#ffe08a}.button.is-warning.is-loading::after{border-color:transparent transparent rgba(0,0,0,.7) rgba(0,0,0,.7)!important}.button.is-warning.is-outlined{background-color:transparent;border-color:#ffe08a;color:#ffe08a}.button.is-warning.is-outlined.is-focused,.button.is-warning.is-outlined.is-hovered,.button.is-warning.is-outlined:focus,.button.is-warning.is-outlined:hover{background-color:#ffe08a;border-color:#ffe08a;color:rgba(0,0,0,.7)}.button.is-warning.is-outlined.is-loading::after{border-color:transparent transparent #ffe08a #ffe08a!important}.button.is-warning.is-outlined.is-loading.is-focused::after,.button.is-warning.is-outlined.is-loading.is-hovered::after,.button.is-warning.is-outlined.is-loading:focus::after,.button.is-warning.is-outlined.is-loading:hover::after{border-color:transparent transparent rgba(0,0,0,.7) rgba(0,0,0,.7)!important}.button.is-warning.is-outlined[disabled],fieldset[disabled] .button.is-warning.is-outlined{background-color:transparent;border-color:#ffe08a;box-shadow:none;color:#ffe08a}.button.is-warning.is-inverted.is-outlined{background-color:transparent;border-color:rgba(0,0,0,.7);color:rgba(0,0,0,.7)}.button.is-warning.is-inverted.is-outlined.is-focused,.button.is-warning.is-inverted.is-outlined.is-hovered,.button.is-warning.is-inverted.is-outlined:focus,.button.is-warning.is-inverted.is-outlined:hover{background-color:rgba(0,0,0,.7);color:#ffe08a}.button.is-warning.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-warning.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-warning.is-inverted.is-outlined.is-loading:focus::after,.button.is-warning.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #ffe08a #ffe08a!important}.button.is-warning.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-warning.is-inverted.is-outlined{background-color:transparent;border-color:rgba(0,0,0,.7);box-shadow:none;color:rgba(0,0,0,.7)}.button.is-warning.is-light{background-color:#fffaeb;color:#946c00}.button.is-warning.is-light.is-hovered,.button.is-warning.is-light:hover{background-color:#fff6de;border-color:transparent;color:#946c00}.button.is-warning.is-light.is-active,.button.is-warning.is-light:active{background-color:#fff3d1;border-color:transparent;color:#946c00}.button.is-danger{background-color:#f14668;border-color:transparent;color:#fff}.button.is-danger.is-hovered,.button.is-danger:hover{background-color:#f03a5f;border-color:transparent;color:#fff}.button.is-danger.is-focused,.button.is-danger:focus{border-color:transparent;color:#fff}.button.is-danger.is-focused:not(:active),.button.is-danger:focus:not(:active){box-shadow:0 0 0 .125em rgba(241,70,104,.25)}.button.is-danger.is-active,.button.is-danger:active{background-color:#ef2e55;border-color:transparent;color:#fff}.button.is-danger[disabled],fieldset[disabled] .button.is-danger{background-color:#f14668;border-color:#f14668;box-shadow:none}.button.is-danger.is-inverted{background-color:#fff;color:#f14668}.button.is-danger.is-inverted.is-hovered,.button.is-danger.is-inverted:hover{background-color:#f2f2f2}.button.is-danger.is-inverted[disabled],fieldset[disabled] .button.is-danger.is-inverted{background-color:#fff;border-color:transparent;box-shadow:none;color:#f14668}.button.is-danger.is-loading::after{border-color:transparent transparent #fff #fff!important}.button.is-danger.is-outlined{background-color:transparent;border-color:#f14668;color:#f14668}.button.is-danger.is-outlined.is-focused,.button.is-danger.is-outlined.is-hovered,.button.is-danger.is-outlined:focus,.button.is-danger.is-outlined:hover{background-color:#f14668;border-color:#f14668;color:#fff}.button.is-danger.is-outlined.is-loading::after{border-color:transparent transparent #f14668 #f14668!important}.button.is-danger.is-outlined.is-loading.is-focused::after,.button.is-danger.is-outlined.is-loading.is-hovered::after,.button.is-danger.is-outlined.is-loading:focus::after,.button.is-danger.is-outlined.is-loading:hover::after{border-color:transparent transparent #fff #fff!important}.button.is-danger.is-outlined[disabled],fieldset[disabled] .button.is-danger.is-outlined{background-color:transparent;border-color:#f14668;box-shadow:none;color:#f14668}.button.is-danger.is-inverted.is-outlined{background-color:transparent;border-color:#fff;color:#fff}.button.is-danger.is-inverted.is-outlined.is-focused,.button.is-danger.is-inverted.is-outlined.is-hovered,.button.is-danger.is-inverted.is-outlined:focus,.button.is-danger.is-inverted.is-outlined:hover{background-color:#fff;color:#f14668}.button.is-danger.is-inverted.is-outlined.is-loading.is-focused::after,.button.is-danger.is-inverted.is-outlined.is-loading.is-hovered::after,.button.is-danger.is-inverted.is-outlined.is-loading:focus::after,.button.is-danger.is-inverted.is-outlined.is-loading:hover::after{border-color:transparent transparent #f14668 #f14668!important}.button.is-danger.is-inverted.is-outlined[disabled],fieldset[disabled] .button.is-danger.is-inverted.is-outlined{background-color:transparent;border-color:#fff;box-shadow:none;color:#fff}.button.is-danger.is-light{background-color:#feecf0;color:#cc0f35}.button.is-danger.is-light.is-hovered,.button.is-danger.is-light:hover{background-color:#fde0e6;border-color:transparent;color:#cc0f35}.button.is-danger.is-light.is-active,.button.is-danger.is-light:active{background-color:#fcd4dc;border-color:transparent;color:#cc0f35}.button.is-small{font-size:.75rem}.button.is-small:not(.is-rounded){border-radius:2px}.button.is-normal{font-size:1rem}.button.is-medium{font-size:1.25rem}.button.is-large{font-size:1.5rem}.button[disabled],fieldset[disabled] .button{background-color:#fff;border-color:#dbdbdb;box-shadow:none;opacity:.5}.button.is-fullwidth{display:flex;width:100%}.button.is-loading{color:transparent!important;pointer-events:none}.button.is-loading::after{position:absolute;left:calc(50% - (1em * .5));top:calc(50% - (1em * .5));position:absolute!important}.button.is-static{background-color:#f5f5f5;border-color:#dbdbdb;color:#7a7a7a;box-shadow:none;pointer-events:none}.button.is-rounded{border-radius:9999px;padding-left:calc(1em + .25em);padding-right:calc(1em + .25em)}.buttons{align-items:center;display:flex;flex-wrap:wrap;justify-content:flex-start}.buttons .button{margin-bottom:.5rem}.buttons .button:not(:last-child):not(.is-fullwidth){margin-right:.5rem}.buttons:last-child{margin-bottom:-.5rem}.buttons:not(:last-child){margin-bottom:1rem}.buttons.are-small .button:not(.is-normal):not(.is-medium):not(.is-large){font-size:.75rem}.buttons.are-small .button:not(.is-normal):not(.is-medium):not(.is-large):not(.is-rounded){border-radius:2px}.buttons.are-medium .button:not(.is-small):not(.is-normal):not(.is-large){font-size:1.25rem}.buttons.are-large .button:not(.is-small):not(.is-normal):not(.is-medium){font-size:1.5rem}.buttons.has-addons .button:not(:first-child){border-bottom-left-radius:0;border-top-left-radius:0}.buttons.has-addons .button:not(:last-child){border-bottom-right-radius:0;border-top-right-radius:0;margin-right:-1px}.buttons.has-addons .button:last-child{margin-right:0}.buttons.has-addons .button.is-hovered,.buttons.has-addons .button:hover{z-index:2}.buttons.has-addons .button.is-active,.buttons.has-addons .button.is-focused,.buttons.has-addons .button.is-selected,.buttons.has-addons .button:active,.buttons.has-addons .button:focus{z-index:3}.buttons.has-addons .button.is-active:hover,.buttons.has-addons .button.is-focused:hover,.buttons.has-addons .button.is-selected:hover,.buttons.has-addons .button:active:hover,.buttons.has-addons .button:focus:hover{z-index:4}.buttons.has-addons .button.is-expanded{flex-grow:1;flex-shrink:1}.buttons.is-centered{justify-content:center}.buttons.is-centered:not(.has-addons) .button:not(.is-fullwidth){margin-left:.25rem;margin-right:.25rem}.buttons.is-right{justify-content:flex-end}.buttons.is-right:not(.has-addons) .button:not(.is-fullwidth){margin-left:.25rem;margin-right:.25rem}@media screen and (max-width:768px){.button.is-responsive.is-small{font-size:.5625rem}.button.is-responsive,.button.is-responsive.is-normal{font-size:.65625rem}.button.is-responsive.is-medium{font-size:.75rem}.button.is-responsive.is-large{font-size:1rem}}@media screen and (min-width:769px) and (max-width:1023px){.button.is-responsive.is-small{font-size:.65625rem}.button.is-responsive,.button.is-responsive.is-normal{font-size:.75rem}.button.is-responsive.is-medium{font-size:1rem}.button.is-responsive.is-large{font-size:1.25rem}}.container{flex-grow:1;margin:0 auto;position:relative;width:auto}.container.is-fluid{max-width:none!important;padding-left:32px;padding-right:32px;width:100%}@media screen and (min-width:1024px){.container{max-width:960px}}@media screen and (max-width:1215px){.container.is-widescreen:not(.is-max-desktop){max-width:1152px}}@media screen and (max-width:1407px){.container.is-fullhd:not(.is-max-desktop):not(.is-max-widescreen){max-width:1344px}}@media screen and (min-width:1216px){.container:not(.is-max-desktop){max-width:1152px}}@media screen and (min-width:1408px){.container:not(.is-max-desktop):not(.is-max-widescreen){max-width:1344px}}.content li+li{margin-top:.25em}.content blockquote:not(:last-child),.content dl:not(:last-child),.content ol:not(:last-child),.content p:not(:last-child),.content pre:not(:last-child),.content table:not(:last-child),.content ul:not(:last-child){margin-bottom:1em}.content h1,.content h2,.content h3,.content h4,.content h5,.content h6{color:#363636;font-weight:600;line-height:1.125}.content h1{font-size:2em;margin-bottom:.5em}.content h1:not(:first-child){margin-top:1em}.content h2{font-size:1.75em;margin-bottom:.5714em}.content h2:not(:first-child){margin-top:1.1428em}.content h3{font-size:1.5em;margin-bottom:.6666em}.content h3:not(:first-child){margin-top:1.3333em}.content h4{font-size:1.25em;margin-bottom:.8em}.content h5{font-size:1.125em;margin-bottom:.8888em}.content h6{font-size:1em;margin-bottom:1em}.content blockquote{background-color:#f5f5f5;border-left:5px solid #dbdbdb;padding:1.25em 1.5em}.content ol{list-style-position:outside;margin-left:2em;margin-top:1em}.content ol:not([type]){list-style-type:decimal}.content ol:not([type]).is-lower-alpha{list-style-type:lower-alpha}.content ol:not([type]).is-lower-roman{list-style-type:lower-roman}.content ol:not([type]).is-upper-alpha{list-style-type:upper-alpha}.content ol:not([type]).is-upper-roman{list-style-type:upper-roman}.content ul{list-style:disc outside;margin-left:2em;margin-top:1em}.content ul ul{list-style-type:circle;margin-top:.5em}.content ul ul ul{list-style-type:square}.content dd{margin-left:2em}.content figure{margin-left:2em;margin-right:2em;text-align:center}.content figure:not(:first-child){margin-top:2em}.content figure:not(:last-child){margin-bottom:2em}.content figure img{display:inline-block}.content figure figcaption{font-style:italic}.content pre{-webkit-overflow-scrolling:touch;overflow-x:auto;padding:1.25em 1.5em;white-space:pre;word-wrap:normal}.content sub,.content sup{font-size:75%}.content table{width:100%}.content table td,.content table th{border:1px solid #dbdbdb;border-width:0 0 1px;padding:.5em .75em;vertical-align:top}.content table th{color:#363636}.content table th:not([align]){text-align:inherit}.content table thead td,.content table thead th{border-width:0 0 2px;color:#363636}.content table tfoot td,.content table tfoot th{border-width:2px 0 0;color:#363636}.content table tbody tr:last-child td,.content table tbody tr:last-child th{border-bottom-width:0}.content .tabs li+li{margin-top:0}.content.is-small{font-size:.75rem}.content.is-normal{font-size:1rem}.content.is-medium{font-size:1.25rem}.content.is-large{font-size:1.5rem}.icon{align-items:center;display:inline-flex;justify-content:center;height:1.5rem;width:1.5rem}.icon.is-small{height:1rem;width:1rem}.icon.is-medium{height:2rem;width:2rem}.icon.is-large{height:3rem;width:3rem}.icon-text{align-items:flex-start;color:inherit;display:inline-flex;flex-wrap:wrap;line-height:1.5rem;vertical-align:top}.icon-text .icon{flex-grow:0;flex-shrink:0}.icon-text .icon:not(:last-child){margin-right:.25em}.icon-text .icon:not(:first-child){margin-left:.25em}div.icon-text{display:flex}.image{display:block;position:relative}.image img{display:block;height:auto;width:100%}.image img.is-rounded{border-radius:9999px}.image.is-fullwidth{width:100%}.image.is-16by9 .has-ratio,.image.is-16by9 img,.image.is-1by1 .has-ratio,.image.is-1by1 img,.image.is-1by2 .has-ratio,.image.is-1by2 img,.image.is-1by3 .has-ratio,.image.is-1by3 img,.image.is-2by1 .has-ratio,.image.is-2by1 img,.image.is-2by3 .has-ratio,.image.is-2by3 img,.image.is-3by1 .has-ratio,.image.is-3by1 img,.image.is-3by2 .has-ratio,.image.is-3by2 img,.image.is-3by4 .has-ratio,.image.is-3by4 img,.image.is-3by5 .has-ratio,.image.is-3by5 img,.image.is-4by3 .has-ratio,.image.is-4by3 img,.image.is-4by5 .has-ratio,.image.is-4by5 img,.image.is-5by3 .has-ratio,.image.is-5by3 img,.image.is-5by4 .has-ratio,.image.is-5by4 img,.image.is-9by16 .has-ratio,.image.is-9by16 img,.image.is-square .has-ratio,.image.is-square img{height:100%;width:100%}.image.is-1by1,.image.is-square{padding-top:100%}.image.is-5by4{padding-top:80%}.image.is-4by3{padding-top:75%}.image.is-3by2{padding-top:66.6666%}.image.is-5by3{padding-top:60%}.image.is-16by9{padding-top:56.25%}.image.is-2by1{padding-top:50%}.image.is-3by1{padding-top:33.3333%}.image.is-4by5{padding-top:125%}.image.is-3by4{padding-top:133.3333%}.image.is-2by3{padding-top:150%}.image.is-3by5{padding-top:166.6666%}.image.is-9by16{padding-top:177.7777%}.image.is-1by2{padding-top:200%}.image.is-1by3{padding-top:300%}.image.is-16x16{height:16px;width:16px}.image.is-24x24{height:24px;width:24px}.image.is-32x32{height:32px;width:32px}.image.is-48x48{height:48px;width:48px}.image.is-64x64{height:64px;width:64px}.image.is-96x96{height:96px;width:96px}.image.is-128x128{height:128px;width:128px}.notification{background-color:#f5f5f5;border-radius:4px;position:relative;padding:1.25rem 2.5rem 1.25rem 1.5rem}.notification a:not(.button):not(.dropdown-item){color:currentColor;text-decoration:underline}.notification strong{color:currentColor}.notification code,.notification pre{background:#fff}.notification pre code{background:0 0}.notification>.delete{right:.5rem;position:absolute;top:.5rem}.notification .content,.notification .subtitle,.notification .title{color:currentColor}.notification.is-white{background-color:#fff;color:#0a0a0a}.notification.is-black{background-color:#0a0a0a;color:#fff}.notification.is-light{background-color:#f5f5f5;color:rgba(0,0,0,.7)}.notification.is-dark{background-color:#363636;color:#fff}.notification.is-primary{background-color:#00d1b2;color:#fff}.notification.is-primary.is-light{background-color:#ebfffc;color:#00947e}.notification.is-link{background-color:#485fc7;color:#fff}.notification.is-link.is-light{background-color:#eff1fa;color:#3850b7}.notification.is-info{background-color:#3e8ed0;color:#fff}.notification.is-info.is-light{background-color:#eff5fb;color:#296fa8}.notification.is-success{background-color:#48c78e;color:#fff}.notification.is-success.is-light{background-color:#effaf5;color:#257953}.notification.is-warning{background-color:#ffe08a;color:rgba(0,0,0,.7)}.notification.is-warning.is-light{background-color:#fffaeb;color:#946c00}.notification.is-danger{background-color:#f14668;color:#fff}.notification.is-danger.is-light{background-color:#feecf0;color:#cc0f35}.progress{-moz-appearance:none;-webkit-appearance:none;border:none;border-radius:9999px;display:block;height:1rem;overflow:hidden;padding:0;width:100%}.progress::-webkit-progress-bar{background-color:#ededed}.progress::-webkit-progress-value{background-color:#4a4a4a}.progress::-moz-progress-bar{background-color:#4a4a4a}.progress::-ms-fill{background-color:#4a4a4a;border:none}.progress.is-white::-webkit-progress-value{background-color:#fff}.progress.is-white::-moz-progress-bar{background-color:#fff}.progress.is-white::-ms-fill{background-color:#fff}.progress.is-white:indeterminate{background-image:linear-gradient(to right,#fff 30%,#ededed 30%)}.progress.is-black::-webkit-progress-value{background-color:#0a0a0a}.progress.is-black::-moz-progress-bar{background-color:#0a0a0a}.progress.is-black::-ms-fill{background-color:#0a0a0a}.progress.is-black:indeterminate{background-image:linear-gradient(to right,#0a0a0a 30%,#ededed 30%)}.progress.is-light::-webkit-progress-value{background-color:#f5f5f5}.progress.is-light::-moz-progress-bar{background-color:#f5f5f5}.progress.is-light::-ms-fill{background-color:#f5f5f5}.progress.is-light:indeterminate{background-image:linear-gradient(to right,#f5f5f5 30%,#ededed 30%)}.progress.is-dark::-webkit-progress-value{background-color:#363636}.progress.is-dark::-moz-progress-bar{background-color:#363636}.progress.is-dark::-ms-fill{background-color:#363636}.progress.is-dark:indeterminate{background-image:linear-gradient(to right,#363636 30%,#ededed 30%)}.progress.is-primary::-webkit-progress-value{background-color:#00d1b2}.progress.is-primary::-moz-progress-bar{background-color:#00d1b2}.progress.is-primary::-ms-fill{background-color:#00d1b2}.progress.is-primary:indeterminate{background-image:linear-gradient(to right,#00d1b2 30%,#ededed 30%)}.progress.is-link::-webkit-progress-value{background-color:#485fc7}.progress.is-link::-moz-progress-bar{background-color:#485fc7}.progress.is-link::-ms-fill{background-color:#485fc7}.progress.is-link:indeterminate{background-image:linear-gradient(to right,#485fc7 30%,#ededed 30%)}.progress.is-info::-webkit-progress-value{background-color:#3e8ed0}.progress.is-info::-moz-progress-bar{background-color:#3e8ed0}.progress.is-info::-ms-fill{background-color:#3e8ed0}.progress.is-info:indeterminate{background-image:linear-gradient(to right,#3e8ed0 30%,#ededed 30%)}.progress.is-success::-webkit-progress-value{background-color:#48c78e}.progress.is-success::-moz-progress-bar{background-color:#48c78e}.progress.is-success::-ms-fill{background-color:#48c78e}.progress.is-success:indeterminate{background-image:linear-gradient(to right,#48c78e 30%,#ededed 30%)}.progress.is-warning::-webkit-progress-value{background-color:#ffe08a}.progress.is-warning::-moz-progress-bar{background-color:#ffe08a}.progress.is-warning::-ms-fill{background-color:#ffe08a}.progress.is-warning:indeterminate{background-image:linear-gradient(to right,#ffe08a 30%,#ededed 30%)}.progress.is-danger::-webkit-progress-value{background-color:#f14668}.progress.is-danger::-moz-progress-bar{background-color:#f14668}.progress.is-danger::-ms-fill{background-color:#f14668}.progress.is-danger:indeterminate{background-image:linear-gradient(to right,#f14668 30%,#ededed 30%)}.progress:indeterminate{-webkit-animation-duration:1.5s;animation-duration:1.5s;-webkit-animation-iteration-count:infinite;animation-iteration-count:infinite;-webkit-animation-name:moveIndeterminate;animation-name:moveIndeterminate;-webkit-animation-timing-function:linear;animation-timing-function:linear;background-color:#ededed;background-image:linear-gradient(to right,#4a4a4a 30%,#ededed 30%);background-position:top left;background-repeat:no-repeat;background-size:150% 150%}.progress:indeterminate::-webkit-progress-bar{background-color:transparent}.progress:indeterminate::-moz-progress-bar{background-color:transparent}.progress:indeterminate::-ms-fill{animation-name:none}.progress.is-small{height:.75rem}.progress.is-medium{height:1.25rem}.progress.is-large{height:1.5rem}@-webkit-keyframes moveIndeterminate{from{background-position:200% 0}to{background-position:-200% 0}}@keyframes moveIndeterminate{from{background-position:200% 0}to{background-position:-200% 0}}.table{background-color:#fff;color:#363636}.table td,.table th{border:1px solid #dbdbdb;border-width:0 0 1px;padding:.5em .75em;vertical-align:top}.table td.is-white,.table th.is-white{background-color:#fff;border-color:#fff;color:#0a0a0a}.table td.is-black,.table th.is-black{background-color:#0a0a0a;border-color:#0a0a0a;color:#fff}.table td.is-light,.table th.is-light{background-color:#f5f5f5;border-color:#f5f5f5;color:rgba(0,0,0,.7)}.table td.is-dark,.table th.is-dark{background-color:#363636;border-color:#363636;color:#fff}.table td.is-primary,.table th.is-primary{background-color:#00d1b2;border-color:#00d1b2;color:#fff}.table td.is-link,.table th.is-link{background-color:#485fc7;border-color:#485fc7;color:#fff}.table td.is-info,.table th.is-info{background-color:#3e8ed0;border-color:#3e8ed0;color:#fff}.table td.is-success,.table th.is-success{background-color:#48c78e;border-color:#48c78e;color:#fff}.table td.is-warning,.table th.is-warning{background-color:#ffe08a;border-color:#ffe08a;color:rgba(0,0,0,.7)}.table td.is-danger,.table th.is-danger{background-color:#f14668;border-color:#f14668;color:#fff}.table td.is-narrow,.table th.is-narrow{white-space:nowrap;width:1%}.table td.is-selected,.table th.is-selected{background-color:#00d1b2;color:#fff}.table td.is-selected a,.table td.is-selected strong,.table th.is-selected a,.table th.is-selected strong{color:currentColor}.table td.is-vcentered,.table th.is-vcentered{vertical-align:middle}.table th{color:#363636}.table th:not([align]){text-align:left}.table tr.is-selected{background-color:#00d1b2;color:#fff}.table tr.is-selected a,.table tr.is-selected strong{color:currentColor}.table tr.is-selected td,.table tr.is-selected th{border-color:#fff;color:currentColor}.table thead{background-color:transparent}.table thead td,.table thead th{border-width:0 0 2px;color:#363636}.table tfoot{background-color:transparent}.table tfoot td,.table tfoot th{border-width:2px 0 0;color:#363636}.table tbody{background-color:transparent}.table tbody tr:last-child td,.table tbody tr:last-child th{border-bottom-width:0}.table.is-bordered td,.table.is-bordered th{border-width:1px}.table.is-bordered tr:last-child td,.table.is-bordered tr:last-child th{border-bottom-width:1px}.table.is-fullwidth{width:100%}.table.is-hoverable tbody tr:not(.is-selected):hover{background-color:#fafafa}.table.is-hoverable.is-striped tbody tr:not(.is-selected):hover{background-color:#fafafa}.table.is-hoverable.is-striped tbody tr:not(.is-selected):hover:nth-child(2n){background-color:#f5f5f5}.table.is-narrow td,.table.is-narrow th{padding:.25em .5em}.table.is-striped tbody tr:not(.is-selected):nth-child(2n){background-color:#fafafa}.table-container{-webkit-overflow-scrolling:touch;overflow:auto;overflow-y:hidden;max-width:100%}.tags{align-items:center;display:flex;flex-wrap:wrap;justify-content:flex-start}.tags .tag{margin-bottom:.5rem}.tags .tag:not(:last-child){margin-right:.5rem}.tags:last-child{margin-bottom:-.5rem}.tags:not(:last-child){margin-bottom:1rem}.tags.are-medium .tag:not(.is-normal):not(.is-large){font-size:1rem}.tags.are-large .tag:not(.is-normal):not(.is-medium){font-size:1.25rem}.tags.is-centered{justify-content:center}.tags.is-centered .tag{margin-right:.25rem;margin-left:.25rem}.tags.is-right{justify-content:flex-end}.tags.is-right .tag:not(:first-child){margin-left:.5rem}.tags.is-right .tag:not(:last-child){margin-right:0}.tags.has-addons .tag{margin-right:0}.tags.has-addons .tag:not(:first-child){margin-left:0;border-top-left-radius:0;border-bottom-left-radius:0}.tags.has-addons .tag:not(:last-child){border-top-right-radius:0;border-bottom-right-radius:0}.tag:not(body){align-items:center;background-color:#f5f5f5;border-radius:4px;color:#4a4a4a;display:inline-flex;font-size:.75rem;height:2em;justify-content:center;line-height:1.5;padding-left:.75em;padding-right:.75em;white-space:nowrap}.tag:not(body) .delete{margin-left:.25rem;margin-right:-.375rem}.tag:not(body).is-white{background-color:#fff;color:#0a0a0a}.tag:not(body).is-black{background-color:#0a0a0a;color:#fff}.tag:not(body).is-light{background-color:#f5f5f5;color:rgba(0,0,0,.7)}.tag:not(body).is-dark{background-color:#363636;color:#fff}.tag:not(body).is-primary{background-color:#00d1b2;color:#fff}.tag:not(body).is-primary.is-light{background-color:#ebfffc;color:#00947e}.tag:not(body).is-link{background-color:#485fc7;color:#fff}.tag:not(body).is-link.is-light{background-color:#eff1fa;color:#3850b7}.tag:not(body).is-info{background-color:#3e8ed0;color:#fff}.tag:not(body).is-info.is-light{background-color:#eff5fb;color:#296fa8}.tag:not(body).is-success{background-color:#48c78e;color:#fff}.tag:not(body).is-success.is-light{background-color:#effaf5;color:#257953}.tag:not(body).is-warning{background-color:#ffe08a;color:rgba(0,0,0,.7)}.tag:not(body).is-warning.is-light{background-color:#fffaeb;color:#946c00}.tag:not(body).is-danger{background-color:#f14668;color:#fff}.tag:not(body).is-danger.is-light{background-color:#feecf0;color:#cc0f35}.tag:not(body).is-normal{font-size:.75rem}.tag:not(body).is-medium{font-size:1rem}.tag:not(body).is-large{font-size:1.25rem}.tag:not(body) .icon:first-child:not(:last-child){margin-left:-.375em;margin-right:.1875em}.tag:not(body) .icon:last-child:not(:first-child){margin-left:.1875em;margin-right:-.375em}.tag:not(body) .icon:first-child:last-child{margin-left:-.375em;margin-right:-.375em}.tag:not(body).is-delete{margin-left:1px;padding:0;position:relative;width:2em}.tag:not(body).is-delete::after,.tag:not(body).is-delete::before{background-color:currentColor;content:\"\";display:block;left:50%;position:absolute;top:50%;transform:translateX(-50%) translateY(-50%) rotate(45deg);transform-origin:center center}.tag:not(body).is-delete::before{height:1px;width:50%}.tag:not(body).is-delete::after{height:50%;width:1px}.tag:not(body).is-delete:focus,.tag:not(body).is-delete:hover{background-color:#e8e8e8}.tag:not(body).is-delete:active{background-color:#dbdbdb}.tag:not(body).is-rounded{border-radius:9999px}a.tag:hover{text-decoration:underline}.subtitle,.title{word-break:break-word}.subtitle em,.subtitle span,.title em,.title span{font-weight:inherit}.subtitle sub,.title sub{font-size:.75em}.subtitle sup,.title sup{font-size:.75em}.subtitle .tag,.title .tag{vertical-align:middle}.title{color:#363636;font-size:2rem;font-weight:600;line-height:1.125}.title strong{color:inherit;font-weight:inherit}.title:not(.is-spaced)+.subtitle{margin-top:-1.25rem}.title.is-1{font-size:3rem}.title.is-2{font-size:2.5rem}.title.is-3{font-size:2rem}.title.is-4{font-size:1.5rem}.title.is-5{font-size:1.25rem}.title.is-6{font-size:1rem}.title.is-7{font-size:.75rem}.subtitle{color:#4a4a4a;font-size:1.25rem;font-weight:400;line-height:1.25}.subtitle strong{color:#363636;font-weight:600}.subtitle:not(.is-spaced)+.title{margin-top:-1.25rem}.subtitle.is-1{font-size:3rem}.subtitle.is-2{font-size:2.5rem}.subtitle.is-3{font-size:2rem}.subtitle.is-4{font-size:1.5rem}.subtitle.is-5{font-size:1.25rem}.subtitle.is-6{font-size:1rem}.subtitle.is-7{font-size:.75rem}.heading{display:block;font-size:11px;letter-spacing:1px;margin-bottom:5px;text-transform:uppercase}.number{align-items:center;background-color:#f5f5f5;border-radius:9999px;display:inline-flex;font-size:1.25rem;height:2em;justify-content:center;margin-right:1.5rem;min-width:2.5em;padding:.25rem .5rem;text-align:center;vertical-align:top}.input,.select select,.textarea{background-color:#fff;border-color:#dbdbdb;border-radius:4px;color:#363636}.input::-moz-placeholder,.select select::-moz-placeholder,.textarea::-moz-placeholder{color:rgba(54,54,54,.3)}.input::-webkit-input-placeholder,.select select::-webkit-input-placeholder,.textarea::-webkit-input-placeholder{color:rgba(54,54,54,.3)}.input:-moz-placeholder,.select select:-moz-placeholder,.textarea:-moz-placeholder{color:rgba(54,54,54,.3)}.input:-ms-input-placeholder,.select select:-ms-input-placeholder,.textarea:-ms-input-placeholder{color:rgba(54,54,54,.3)}.input:hover,.is-hovered.input,.is-hovered.textarea,.select select.is-hovered,.select select:hover,.textarea:hover{border-color:#b5b5b5}.input:active,.input:focus,.is-active.input,.is-active.textarea,.is-focused.input,.is-focused.textarea,.select select.is-active,.select select.is-focused,.select select:active,.select select:focus,.textarea:active,.textarea:focus{border-color:#485fc7;box-shadow:0 0 0 .125em rgba(72,95,199,.25)}.input[disabled],.select fieldset[disabled] select,.select select[disabled],.textarea[disabled],fieldset[disabled] .input,fieldset[disabled] .select select,fieldset[disabled] .textarea{background-color:#f5f5f5;border-color:#f5f5f5;box-shadow:none;color:#7a7a7a}.input[disabled]::-moz-placeholder,.select fieldset[disabled] select::-moz-placeholder,.select select[disabled]::-moz-placeholder,.textarea[disabled]::-moz-placeholder,fieldset[disabled] .input::-moz-placeholder,fieldset[disabled] .select select::-moz-placeholder,fieldset[disabled] .textarea::-moz-placeholder{color:rgba(122,122,122,.3)}.input[disabled]::-webkit-input-placeholder,.select fieldset[disabled] select::-webkit-input-placeholder,.select select[disabled]::-webkit-input-placeholder,.textarea[disabled]::-webkit-input-placeholder,fieldset[disabled] .input::-webkit-input-placeholder,fieldset[disabled] .select select::-webkit-input-placeholder,fieldset[disabled] .textarea::-webkit-input-placeholder{color:rgba(122,122,122,.3)}.input[disabled]:-moz-placeholder,.select fieldset[disabled] select:-moz-placeholder,.select select[disabled]:-moz-placeholder,.textarea[disabled]:-moz-placeholder,fieldset[disabled] .input:-moz-placeholder,fieldset[disabled] .select select:-moz-placeholder,fieldset[disabled] .textarea:-moz-placeholder{color:rgba(122,122,122,.3)}.input[disabled]:-ms-input-placeholder,.select fieldset[disabled] select:-ms-input-placeholder,.select select[disabled]:-ms-input-placeholder,.textarea[disabled]:-ms-input-placeholder,fieldset[disabled] .input:-ms-input-placeholder,fieldset[disabled] .select select:-ms-input-placeholder,fieldset[disabled] .textarea:-ms-input-placeholder{color:rgba(122,122,122,.3)}.input,.textarea{box-shadow:inset 0 .0625em .125em rgba(10,10,10,.05);max-width:100%;width:100%}.input[readonly],.textarea[readonly]{box-shadow:none}.is-white.input,.is-white.textarea{border-color:#fff}.is-white.input:active,.is-white.input:focus,.is-white.is-active.input,.is-white.is-active.textarea,.is-white.is-focused.input,.is-white.is-focused.textarea,.is-white.textarea:active,.is-white.textarea:focus{box-shadow:0 0 0 .125em rgba(255,255,255,.25)}.is-black.input,.is-black.textarea{border-color:#0a0a0a}.is-black.input:active,.is-black.input:focus,.is-black.is-active.input,.is-black.is-active.textarea,.is-black.is-focused.input,.is-black.is-focused.textarea,.is-black.textarea:active,.is-black.textarea:focus{box-shadow:0 0 0 .125em rgba(10,10,10,.25)}.is-light.input,.is-light.textarea{border-color:#f5f5f5}.is-light.input:active,.is-light.input:focus,.is-light.is-active.input,.is-light.is-active.textarea,.is-light.is-focused.input,.is-light.is-focused.textarea,.is-light.textarea:active,.is-light.textarea:focus{box-shadow:0 0 0 .125em rgba(245,245,245,.25)}.is-dark.input,.is-dark.textarea{border-color:#363636}.is-dark.input:active,.is-dark.input:focus,.is-dark.is-active.input,.is-dark.is-active.textarea,.is-dark.is-focused.input,.is-dark.is-focused.textarea,.is-dark.textarea:active,.is-dark.textarea:focus{box-shadow:0 0 0 .125em rgba(54,54,54,.25)}.is-primary.input,.is-primary.textarea{border-color:#00d1b2}.is-primary.input:active,.is-primary.input:focus,.is-primary.is-active.input,.is-primary.is-active.textarea,.is-primary.is-focused.input,.is-primary.is-focused.textarea,.is-primary.textarea:active,.is-primary.textarea:focus{box-shadow:0 0 0 .125em rgba(0,209,178,.25)}.is-link.input,.is-link.textarea{border-color:#485fc7}.is-link.input:active,.is-link.input:focus,.is-link.is-active.input,.is-link.is-active.textarea,.is-link.is-focused.input,.is-link.is-focused.textarea,.is-link.textarea:active,.is-link.textarea:focus{box-shadow:0 0 0 .125em rgba(72,95,199,.25)}.is-info.input,.is-info.textarea{border-color:#3e8ed0}.is-info.input:active,.is-info.input:focus,.is-info.is-active.input,.is-info.is-active.textarea,.is-info.is-focused.input,.is-info.is-focused.textarea,.is-info.textarea:active,.is-info.textarea:focus{box-shadow:0 0 0 .125em rgba(62,142,208,.25)}.is-success.input,.is-success.textarea{border-color:#48c78e}.is-success.input:active,.is-success.input:focus,.is-success.is-active.input,.is-success.is-active.textarea,.is-success.is-focused.input,.is-success.is-focused.textarea,.is-success.textarea:active,.is-success.textarea:focus{box-shadow:0 0 0 .125em rgba(72,199,142,.25)}.is-warning.input,.is-warning.textarea{border-color:#ffe08a}.is-warning.input:active,.is-warning.input:focus,.is-warning.is-active.input,.is-warning.is-active.textarea,.is-warning.is-focused.input,.is-warning.is-focused.textarea,.is-warning.textarea:active,.is-warning.textarea:focus{box-shadow:0 0 0 .125em rgba(255,224,138,.25)}.is-danger.input,.is-danger.textarea{border-color:#f14668}.is-danger.input:active,.is-danger.input:focus,.is-danger.is-active.input,.is-danger.is-active.textarea,.is-danger.is-focused.input,.is-danger.is-focused.textarea,.is-danger.textarea:active,.is-danger.textarea:focus{box-shadow:0 0 0 .125em rgba(241,70,104,.25)}.is-small.input,.is-small.textarea{border-radius:2px;font-size:.75rem}.is-medium.input,.is-medium.textarea{font-size:1.25rem}.is-large.input,.is-large.textarea{font-size:1.5rem}.is-fullwidth.input,.is-fullwidth.textarea{display:block;width:100%}.is-inline.input,.is-inline.textarea{display:inline;width:auto}.input.is-rounded{border-radius:9999px;padding-left:calc(calc(.75em - 1px) + .375em);padding-right:calc(calc(.75em - 1px) + .375em)}.input.is-static{background-color:transparent;border-color:transparent;box-shadow:none;padding-left:0;padding-right:0}.textarea{display:block;max-width:100%;min-width:100%;padding:calc(.75em - 1px);resize:vertical}.textarea:not([rows]){max-height:40em;min-height:8em}.textarea[rows]{height:initial}.textarea.has-fixed-size{resize:none}.checkbox,.radio{cursor:pointer;display:inline-block;line-height:1.25;position:relative}.checkbox input,.radio input{cursor:pointer}.checkbox:hover,.radio:hover{color:#363636}.checkbox input[disabled],.checkbox[disabled],.radio input[disabled],.radio[disabled],fieldset[disabled] .checkbox,fieldset[disabled] .radio{color:#7a7a7a;cursor:not-allowed}.radio+.radio{margin-left:.5em}.select{display:inline-block;max-width:100%;position:relative;vertical-align:top}.select:not(.is-multiple){height:2.5em}.select:not(.is-multiple):not(.is-loading)::after{border-color:#485fc7;right:1.125em;z-index:4}.select.is-rounded select{border-radius:9999px;padding-left:1em}.select select{cursor:pointer;display:block;font-size:1em;max-width:100%;outline:0}.select select::-ms-expand{display:none}.select select[disabled]:hover,fieldset[disabled] .select select:hover{border-color:#f5f5f5}.select select:not([multiple]){padding-right:2.5em}.select select[multiple]{height:auto;padding:0}.select select[multiple] option{padding:.5em 1em}.select:not(.is-multiple):not(.is-loading):hover::after{border-color:#363636}.select.is-white:not(:hover)::after{border-color:#fff}.select.is-white select{border-color:#fff}.select.is-white select.is-hovered,.select.is-white select:hover{border-color:#f2f2f2}.select.is-white select.is-active,.select.is-white select.is-focused,.select.is-white select:active,.select.is-white select:focus{box-shadow:0 0 0 .125em rgba(255,255,255,.25)}.select.is-black:not(:hover)::after{border-color:#0a0a0a}.select.is-black select{border-color:#0a0a0a}.select.is-black select.is-hovered,.select.is-black select:hover{border-color:#000}.select.is-black select.is-active,.select.is-black select.is-focused,.select.is-black select:active,.select.is-black select:focus{box-shadow:0 0 0 .125em rgba(10,10,10,.25)}.select.is-light:not(:hover)::after{border-color:#f5f5f5}.select.is-light select{border-color:#f5f5f5}.select.is-light select.is-hovered,.select.is-light select:hover{border-color:#e8e8e8}.select.is-light select.is-active,.select.is-light select.is-focused,.select.is-light select:active,.select.is-light select:focus{box-shadow:0 0 0 .125em rgba(245,245,245,.25)}.select.is-dark:not(:hover)::after{border-color:#363636}.select.is-dark select{border-color:#363636}.select.is-dark select.is-hovered,.select.is-dark select:hover{border-color:#292929}.select.is-dark select.is-active,.select.is-dark select.is-focused,.select.is-dark select:active,.select.is-dark select:focus{box-shadow:0 0 0 .125em rgba(54,54,54,.25)}.select.is-primary:not(:hover)::after{border-color:#00d1b2}.select.is-primary select{border-color:#00d1b2}.select.is-primary select.is-hovered,.select.is-primary select:hover{border-color:#00b89c}.select.is-primary select.is-active,.select.is-primary select.is-focused,.select.is-primary select:active,.select.is-primary select:focus{box-shadow:0 0 0 .125em rgba(0,209,178,.25)}.select.is-link:not(:hover)::after{border-color:#485fc7}.select.is-link select{border-color:#485fc7}.select.is-link select.is-hovered,.select.is-link select:hover{border-color:#3a51bb}.select.is-link select.is-active,.select.is-link select.is-focused,.select.is-link select:active,.select.is-link select:focus{box-shadow:0 0 0 .125em rgba(72,95,199,.25)}.select.is-info:not(:hover)::after{border-color:#3e8ed0}.select.is-info select{border-color:#3e8ed0}.select.is-info select.is-hovered,.select.is-info select:hover{border-color:#3082c5}.select.is-info select.is-active,.select.is-info select.is-focused,.select.is-info select:active,.select.is-info select:focus{box-shadow:0 0 0 .125em rgba(62,142,208,.25)}.select.is-success:not(:hover)::after{border-color:#48c78e}.select.is-success select{border-color:#48c78e}.select.is-success select.is-hovered,.select.is-success select:hover{border-color:#3abb81}.select.is-success select.is-active,.select.is-success select.is-focused,.select.is-success select:active,.select.is-success select:focus{box-shadow:0 0 0 .125em rgba(72,199,142,.25)}.select.is-warning:not(:hover)::after{border-color:#ffe08a}.select.is-warning select{border-color:#ffe08a}.select.is-warning select.is-hovered,.select.is-warning select:hover{border-color:#ffd970}.select.is-warning select.is-active,.select.is-warning select.is-focused,.select.is-warning select:active,.select.is-warning select:focus{box-shadow:0 0 0 .125em rgba(255,224,138,.25)}.select.is-danger:not(:hover)::after{border-color:#f14668}.select.is-danger select{border-color:#f14668}.select.is-danger select.is-hovered,.select.is-danger select:hover{border-color:#ef2e55}.select.is-danger select.is-active,.select.is-danger select.is-focused,.select.is-danger select:active,.select.is-danger select:focus{box-shadow:0 0 0 .125em rgba(241,70,104,.25)}.select.is-small{border-radius:2px;font-size:.75rem}.select.is-medium{font-size:1.25rem}.select.is-large{font-size:1.5rem}.select.is-disabled::after{border-color:#7a7a7a!important;opacity:.5}.select.is-fullwidth{width:100%}.select.is-fullwidth select{width:100%}.select.is-loading::after{margin-top:0;position:absolute;right:.625em;top:.625em;transform:none}.select.is-loading.is-small:after{font-size:.75rem}.select.is-loading.is-medium:after{font-size:1.25rem}.select.is-loading.is-large:after{font-size:1.5rem}.file{align-items:stretch;display:flex;justify-content:flex-start;position:relative}.file.is-white .file-cta{background-color:#fff;border-color:transparent;color:#0a0a0a}.file.is-white.is-hovered .file-cta,.file.is-white:hover .file-cta{background-color:#f9f9f9;border-color:transparent;color:#0a0a0a}.file.is-white.is-focused .file-cta,.file.is-white:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(255,255,255,.25);color:#0a0a0a}.file.is-white.is-active .file-cta,.file.is-white:active .file-cta{background-color:#f2f2f2;border-color:transparent;color:#0a0a0a}.file.is-black .file-cta{background-color:#0a0a0a;border-color:transparent;color:#fff}.file.is-black.is-hovered .file-cta,.file.is-black:hover .file-cta{background-color:#040404;border-color:transparent;color:#fff}.file.is-black.is-focused .file-cta,.file.is-black:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(10,10,10,.25);color:#fff}.file.is-black.is-active .file-cta,.file.is-black:active .file-cta{background-color:#000;border-color:transparent;color:#fff}.file.is-light .file-cta{background-color:#f5f5f5;border-color:transparent;color:rgba(0,0,0,.7)}.file.is-light.is-hovered .file-cta,.file.is-light:hover .file-cta{background-color:#eee;border-color:transparent;color:rgba(0,0,0,.7)}.file.is-light.is-focused .file-cta,.file.is-light:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(245,245,245,.25);color:rgba(0,0,0,.7)}.file.is-light.is-active .file-cta,.file.is-light:active .file-cta{background-color:#e8e8e8;border-color:transparent;color:rgba(0,0,0,.7)}.file.is-dark .file-cta{background-color:#363636;border-color:transparent;color:#fff}.file.is-dark.is-hovered .file-cta,.file.is-dark:hover .file-cta{background-color:#2f2f2f;border-color:transparent;color:#fff}.file.is-dark.is-focused .file-cta,.file.is-dark:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(54,54,54,.25);color:#fff}.file.is-dark.is-active .file-cta,.file.is-dark:active .file-cta{background-color:#292929;border-color:transparent;color:#fff}.file.is-primary .file-cta{background-color:#00d1b2;border-color:transparent;color:#fff}.file.is-primary.is-hovered .file-cta,.file.is-primary:hover .file-cta{background-color:#00c4a7;border-color:transparent;color:#fff}.file.is-primary.is-focused .file-cta,.file.is-primary:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(0,209,178,.25);color:#fff}.file.is-primary.is-active .file-cta,.file.is-primary:active .file-cta{background-color:#00b89c;border-color:transparent;color:#fff}.file.is-link .file-cta{background-color:#485fc7;border-color:transparent;color:#fff}.file.is-link.is-hovered .file-cta,.file.is-link:hover .file-cta{background-color:#3e56c4;border-color:transparent;color:#fff}.file.is-link.is-focused .file-cta,.file.is-link:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(72,95,199,.25);color:#fff}.file.is-link.is-active .file-cta,.file.is-link:active .file-cta{background-color:#3a51bb;border-color:transparent;color:#fff}.file.is-info .file-cta{background-color:#3e8ed0;border-color:transparent;color:#fff}.file.is-info.is-hovered .file-cta,.file.is-info:hover .file-cta{background-color:#3488ce;border-color:transparent;color:#fff}.file.is-info.is-focused .file-cta,.file.is-info:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(62,142,208,.25);color:#fff}.file.is-info.is-active .file-cta,.file.is-info:active .file-cta{background-color:#3082c5;border-color:transparent;color:#fff}.file.is-success .file-cta{background-color:#48c78e;border-color:transparent;color:#fff}.file.is-success.is-hovered .file-cta,.file.is-success:hover .file-cta{background-color:#3ec487;border-color:transparent;color:#fff}.file.is-success.is-focused .file-cta,.file.is-success:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(72,199,142,.25);color:#fff}.file.is-success.is-active .file-cta,.file.is-success:active .file-cta{background-color:#3abb81;border-color:transparent;color:#fff}.file.is-warning .file-cta{background-color:#ffe08a;border-color:transparent;color:rgba(0,0,0,.7)}.file.is-warning.is-hovered .file-cta,.file.is-warning:hover .file-cta{background-color:#ffdc7d;border-color:transparent;color:rgba(0,0,0,.7)}.file.is-warning.is-focused .file-cta,.file.is-warning:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(255,224,138,.25);color:rgba(0,0,0,.7)}.file.is-warning.is-active .file-cta,.file.is-warning:active .file-cta{background-color:#ffd970;border-color:transparent;color:rgba(0,0,0,.7)}.file.is-danger .file-cta{background-color:#f14668;border-color:transparent;color:#fff}.file.is-danger.is-hovered .file-cta,.file.is-danger:hover .file-cta{background-color:#f03a5f;border-color:transparent;color:#fff}.file.is-danger.is-focused .file-cta,.file.is-danger:focus .file-cta{border-color:transparent;box-shadow:0 0 .5em rgba(241,70,104,.25);color:#fff}.file.is-danger.is-active .file-cta,.file.is-danger:active .file-cta{background-color:#ef2e55;border-color:transparent;color:#fff}.file.is-small{font-size:.75rem}.file.is-normal{font-size:1rem}.file.is-medium{font-size:1.25rem}.file.is-medium .file-icon .fa{font-size:21px}.file.is-large{font-size:1.5rem}.file.is-large .file-icon .fa{font-size:28px}.file.has-name .file-cta{border-bottom-right-radius:0;border-top-right-radius:0}.file.has-name .file-name{border-bottom-left-radius:0;border-top-left-radius:0}.file.has-name.is-empty .file-cta{border-radius:4px}.file.has-name.is-empty .file-name{display:none}.file.is-boxed .file-label{flex-direction:column}.file.is-boxed .file-cta{flex-direction:column;height:auto;padding:1em 3em}.file.is-boxed .file-name{border-width:0 1px 1px}.file.is-boxed .file-icon{height:1.5em;width:1.5em}.file.is-boxed .file-icon .fa{font-size:21px}.file.is-boxed.is-small .file-icon .fa{font-size:14px}.file.is-boxed.is-medium .file-icon .fa{font-size:28px}.file.is-boxed.is-large .file-icon .fa{font-size:35px}.file.is-boxed.has-name .file-cta{border-radius:4px 4px 0 0}.file.is-boxed.has-name .file-name{border-radius:0 0 4px 4px;border-width:0 1px 1px}.file.is-centered{justify-content:center}.file.is-fullwidth .file-label{width:100%}.file.is-fullwidth .file-name{flex-grow:1;max-width:none}.file.is-right{justify-content:flex-end}.file.is-right .file-cta{border-radius:0 4px 4px 0}.file.is-right .file-name{border-radius:4px 0 0 4px;border-width:1px 0 1px 1px;order:-1}.file-label{align-items:stretch;display:flex;cursor:pointer;justify-content:flex-start;overflow:hidden;position:relative}.file-label:hover .file-cta{background-color:#eee;color:#363636}.file-label:hover .file-name{border-color:#d5d5d5}.file-label:active .file-cta{background-color:#e8e8e8;color:#363636}.file-label:active .file-name{border-color:#cfcfcf}.file-input{height:100%;left:0;opacity:0;outline:0;position:absolute;top:0;width:100%}.file-cta,.file-name{border-color:#dbdbdb;border-radius:4px;font-size:1em;padding-left:1em;padding-right:1em;white-space:nowrap}.file-cta{background-color:#f5f5f5;color:#4a4a4a}.file-name{border-color:#dbdbdb;border-style:solid;border-width:1px 1px 1px 0;display:block;max-width:16em;overflow:hidden;text-align:inherit;text-overflow:ellipsis}.file-icon{align-items:center;display:flex;height:1em;justify-content:center;margin-right:.5em;width:1em}.file-icon .fa{font-size:14px}.label{color:#363636;display:block;font-size:1rem;font-weight:700}.label:not(:last-child){margin-bottom:.5em}.label.is-small{font-size:.75rem}.label.is-medium{font-size:1.25rem}.label.is-large{font-size:1.5rem}.help{display:block;font-size:.75rem;margin-top:.25rem}.help.is-white{color:#fff}.help.is-black{color:#0a0a0a}.help.is-light{color:#f5f5f5}.help.is-dark{color:#363636}.help.is-primary{color:#00d1b2}.help.is-link{color:#485fc7}.help.is-info{color:#3e8ed0}.help.is-success{color:#48c78e}.help.is-warning{color:#ffe08a}.help.is-danger{color:#f14668}.field:not(:last-child){margin-bottom:.75rem}.field.has-addons{display:flex;justify-content:flex-start}.field.has-addons .control:not(:last-child){margin-right:-1px}.field.has-addons .control:not(:first-child):not(:last-child) .button,.field.has-addons .control:not(:first-child):not(:last-child) .input,.field.has-addons .control:not(:first-child):not(:last-child) .select select{border-radius:0}.field.has-addons .control:first-child:not(:only-child) .button,.field.has-addons .control:first-child:not(:only-child) .input,.field.has-addons .control:first-child:not(:only-child) .select select{border-bottom-right-radius:0;border-top-right-radius:0}.field.has-addons .control:last-child:not(:only-child) .button,.field.has-addons .control:last-child:not(:only-child) .input,.field.has-addons .control:last-child:not(:only-child) .select select{border-bottom-left-radius:0;border-top-left-radius:0}.field.has-addons .control .button:not([disabled]).is-hovered,.field.has-addons .control .button:not([disabled]):hover,.field.has-addons .control .input:not([disabled]).is-hovered,.field.has-addons .control .input:not([disabled]):hover,.field.has-addons .control .select select:not([disabled]).is-hovered,.field.has-addons .control .select select:not([disabled]):hover{z-index:2}.field.has-addons .control .button:not([disabled]).is-active,.field.has-addons .control .button:not([disabled]).is-focused,.field.has-addons .control .button:not([disabled]):active,.field.has-addons .control .button:not([disabled]):focus,.field.has-addons .control .input:not([disabled]).is-active,.field.has-addons .control .input:not([disabled]).is-focused,.field.has-addons .control .input:not([disabled]):active,.field.has-addons .control .input:not([disabled]):focus,.field.has-addons .control .select select:not([disabled]).is-active,.field.has-addons .control .select select:not([disabled]).is-focused,.field.has-addons .control .select select:not([disabled]):active,.field.has-addons .control .select select:not([disabled]):focus{z-index:3}.field.has-addons .control .button:not([disabled]).is-active:hover,.field.has-addons .control .button:not([disabled]).is-focused:hover,.field.has-addons .control .button:not([disabled]):active:hover,.field.has-addons .control .button:not([disabled]):focus:hover,.field.has-addons .control .input:not([disabled]).is-active:hover,.field.has-addons .control .input:not([disabled]).is-focused:hover,.field.has-addons .control .input:not([disabled]):active:hover,.field.has-addons .control .input:not([disabled]):focus:hover,.field.has-addons .control .select select:not([disabled]).is-active:hover,.field.has-addons .control .select select:not([disabled]).is-focused:hover,.field.has-addons .control .select select:not([disabled]):active:hover,.field.has-addons .control .select select:not([disabled]):focus:hover{z-index:4}.field.has-addons .control.is-expanded{flex-grow:1;flex-shrink:1}.field.has-addons.has-addons-centered{justify-content:center}.field.has-addons.has-addons-right{justify-content:flex-end}.field.has-addons.has-addons-fullwidth .control{flex-grow:1;flex-shrink:0}.field.is-grouped{display:flex;justify-content:flex-start}.field.is-grouped>.control{flex-shrink:0}.field.is-grouped>.control:not(:last-child){margin-bottom:0;margin-right:.75rem}.field.is-grouped>.control.is-expanded{flex-grow:1;flex-shrink:1}.field.is-grouped.is-grouped-centered{justify-content:center}.field.is-grouped.is-grouped-right{justify-content:flex-end}.field.is-grouped.is-grouped-multiline{flex-wrap:wrap}.field.is-grouped.is-grouped-multiline>.control:last-child,.field.is-grouped.is-grouped-multiline>.control:not(:last-child){margin-bottom:.75rem}.field.is-grouped.is-grouped-multiline:last-child{margin-bottom:-.75rem}.field.is-grouped.is-grouped-multiline:not(:last-child){margin-bottom:0}@media screen and (min-width:769px),print{.field.is-horizontal{display:flex}}.field-label .label{font-size:inherit}@media screen and (max-width:768px){.field-label{margin-bottom:.5rem}}@media screen and (min-width:769px),print{.field-label{flex-basis:0;flex-grow:1;flex-shrink:0;margin-right:1.5rem;text-align:right}.field-label.is-small{font-size:.75rem;padding-top:.375em}.field-label.is-normal{padding-top:.375em}.field-label.is-medium{font-size:1.25rem;padding-top:.375em}.field-label.is-large{font-size:1.5rem;padding-top:.375em}}.field-body .field .field{margin-bottom:0}@media screen and (min-width:769px),print{.field-body{display:flex;flex-basis:0;flex-grow:5;flex-shrink:1}.field-body .field{margin-bottom:0}.field-body>.field{flex-shrink:1}.field-body>.field:not(.is-narrow){flex-grow:1}.field-body>.field:not(:last-child){margin-right:.75rem}}.control{box-sizing:border-box;clear:both;font-size:1rem;position:relative;text-align:inherit}.control.has-icons-left .input:focus~.icon,.control.has-icons-left .select:focus~.icon,.control.has-icons-right .input:focus~.icon,.control.has-icons-right .select:focus~.icon{color:#4a4a4a}.control.has-icons-left .input.is-small~.icon,.control.has-icons-left .select.is-small~.icon,.control.has-icons-right .input.is-small~.icon,.control.has-icons-right .select.is-small~.icon{font-size:.75rem}.control.has-icons-left .input.is-medium~.icon,.control.has-icons-left .select.is-medium~.icon,.control.has-icons-right .input.is-medium~.icon,.control.has-icons-right .select.is-medium~.icon{font-size:1.25rem}.control.has-icons-left .input.is-large~.icon,.control.has-icons-left .select.is-large~.icon,.control.has-icons-right .input.is-large~.icon,.control.has-icons-right .select.is-large~.icon{font-size:1.5rem}.control.has-icons-left .icon,.control.has-icons-right .icon{color:#dbdbdb;height:2.5em;pointer-events:none;position:absolute;top:0;width:2.5em;z-index:4}.control.has-icons-left .input,.control.has-icons-left .select select{padding-left:2.5em}.control.has-icons-left .icon.is-left{left:0}.control.has-icons-right .input,.control.has-icons-right .select select{padding-right:2.5em}.control.has-icons-right .icon.is-right{right:0}.control.is-loading::after{position:absolute!important;right:.625em;top:.625em;z-index:4}.control.is-loading.is-small:after{font-size:.75rem}.control.is-loading.is-medium:after{font-size:1.25rem}.control.is-loading.is-large:after{font-size:1.5rem}.breadcrumb{font-size:1rem;white-space:nowrap}.breadcrumb a{align-items:center;color:#485fc7;display:flex;justify-content:center;padding:0 .75em}.breadcrumb a:hover{color:#363636}.breadcrumb li{align-items:center;display:flex}.breadcrumb li:first-child a{padding-left:0}.breadcrumb li.is-active a{color:#363636;cursor:default;pointer-events:none}.breadcrumb li+li::before{color:#b5b5b5;content:\"\\0002f\"}.breadcrumb ol,.breadcrumb ul{align-items:flex-start;display:flex;flex-wrap:wrap;justify-content:flex-start}.breadcrumb .icon:first-child{margin-right:.5em}.breadcrumb .icon:last-child{margin-left:.5em}.breadcrumb.is-centered ol,.breadcrumb.is-centered ul{justify-content:center}.breadcrumb.is-right ol,.breadcrumb.is-right ul{justify-content:flex-end}.breadcrumb.is-small{font-size:.75rem}.breadcrumb.is-medium{font-size:1.25rem}.breadcrumb.is-large{font-size:1.5rem}.breadcrumb.has-arrow-separator li+li::before{content:\"\\02192\"}.breadcrumb.has-bullet-separator li+li::before{content:\"\\02022\"}.breadcrumb.has-dot-separator li+li::before{content:\"\\000b7\"}.breadcrumb.has-succeeds-separator li+li::before{content:\"\\0227B\"}.card{background-color:#fff;border-radius:.25rem;box-shadow:0 .5em 1em -.125em rgba(10,10,10,.1),0 0 0 1px rgba(10,10,10,.02);color:#4a4a4a;max-width:100%;position:relative}.card-content:first-child,.card-footer:first-child,.card-header:first-child{border-top-left-radius:.25rem;border-top-right-radius:.25rem}.card-content:last-child,.card-footer:last-child,.card-header:last-child{border-bottom-left-radius:.25rem;border-bottom-right-radius:.25rem}.card-header{background-color:transparent;align-items:stretch;box-shadow:0 .125em .25em rgba(10,10,10,.1);display:flex}.card-header-title{align-items:center;color:#363636;display:flex;flex-grow:1;font-weight:700;padding:.75rem 1rem}.card-header-title.is-centered{justify-content:center}.card-header-icon{-moz-appearance:none;-webkit-appearance:none;appearance:none;background:0 0;border:none;color:currentColor;font-family:inherit;font-size:1em;margin:0;padding:0;align-items:center;cursor:pointer;display:flex;justify-content:center;padding:.75rem 1rem}.card-image{display:block;position:relative}.card-image:first-child img{border-top-left-radius:.25rem;border-top-right-radius:.25rem}.card-image:last-child img{border-bottom-left-radius:.25rem;border-bottom-right-radius:.25rem}.card-content{background-color:transparent;padding:1.5rem}.card-footer{background-color:transparent;border-top:1px solid #ededed;align-items:stretch;display:flex}.card-footer-item{align-items:center;display:flex;flex-basis:0;flex-grow:1;flex-shrink:0;justify-content:center;padding:.75rem}.card-footer-item:not(:last-child){border-right:1px solid #ededed}.card .media:not(:last-child){margin-bottom:1.5rem}.dropdown{display:inline-flex;position:relative;vertical-align:top}.dropdown.is-active .dropdown-menu,.dropdown.is-hoverable:hover .dropdown-menu{display:block}.dropdown.is-right .dropdown-menu{left:auto;right:0}.dropdown.is-up .dropdown-menu{bottom:100%;padding-bottom:4px;padding-top:initial;top:auto}.dropdown-menu{display:none;left:0;min-width:12rem;padding-top:4px;position:absolute;top:100%;z-index:20}.dropdown-content{background-color:#fff;border-radius:4px;box-shadow:0 .5em 1em -.125em rgba(10,10,10,.1),0 0 0 1px rgba(10,10,10,.02);padding-bottom:.5rem;padding-top:.5rem}.dropdown-item{color:#4a4a4a;display:block;font-size:.875rem;line-height:1.5;padding:.375rem 1rem;position:relative}a.dropdown-item,button.dropdown-item{padding-right:3rem;text-align:inherit;white-space:nowrap;width:100%}a.dropdown-item:hover,button.dropdown-item:hover{background-color:#f5f5f5;color:#0a0a0a}a.dropdown-item.is-active,button.dropdown-item.is-active{background-color:#485fc7;color:#fff}.dropdown-divider{background-color:#ededed;border:none;display:block;height:1px;margin:.5rem 0}.level{align-items:center;justify-content:space-between}.level code{border-radius:4px}.level img{display:inline-block;vertical-align:top}.level.is-mobile{display:flex}.level.is-mobile .level-left,.level.is-mobile .level-right{display:flex}.level.is-mobile .level-left+.level-right{margin-top:0}.level.is-mobile .level-item:not(:last-child){margin-bottom:0;margin-right:.75rem}.level.is-mobile .level-item:not(.is-narrow){flex-grow:1}@media screen and (min-width:769px),print{.level{display:flex}.level>.level-item:not(.is-narrow){flex-grow:1}}.level-item{align-items:center;display:flex;flex-basis:auto;flex-grow:0;flex-shrink:0;justify-content:center}.level-item .subtitle,.level-item .title{margin-bottom:0}@media screen and (max-width:768px){.level-item:not(:last-child){margin-bottom:.75rem}}.level-left,.level-right{flex-basis:auto;flex-grow:0;flex-shrink:0}.level-left .level-item.is-flexible,.level-right .level-item.is-flexible{flex-grow:1}@media screen and (min-width:769px),print{.level-left .level-item:not(:last-child),.level-right .level-item:not(:last-child){margin-right:.75rem}}.level-left{align-items:center;justify-content:flex-start}@media screen and (max-width:768px){.level-left+.level-right{margin-top:1.5rem}}@media screen and (min-width:769px),print{.level-left{display:flex}}.level-right{align-items:center;justify-content:flex-end}@media screen and (min-width:769px),print{.level-right{display:flex}}.media{align-items:flex-start;display:flex;text-align:inherit}.media .content:not(:last-child){margin-bottom:.75rem}.media .media{border-top:1px solid rgba(219,219,219,.5);display:flex;padding-top:.75rem}.media .media .content:not(:last-child),.media .media .control:not(:last-child){margin-bottom:.5rem}.media .media .media{padding-top:.5rem}.media .media .media+.media{margin-top:.5rem}.media+.media{border-top:1px solid rgba(219,219,219,.5);margin-top:1rem;padding-top:1rem}.media.is-large+.media{margin-top:1.5rem;padding-top:1.5rem}.media-left,.media-right{flex-basis:auto;flex-grow:0;flex-shrink:0}.media-left{margin-right:1rem}.media-right{margin-left:1rem}.media-content{flex-basis:auto;flex-grow:1;flex-shrink:1;text-align:inherit}@media screen and (max-width:768px){.media-content{overflow-x:auto}}.menu{font-size:1rem}.menu.is-small{font-size:.75rem}.menu.is-medium{font-size:1.25rem}.menu.is-large{font-size:1.5rem}.menu-list{line-height:1.25}.menu-list a{border-radius:2px;color:#4a4a4a;display:block;padding:.5em .75em}.menu-list a:hover{background-color:#f5f5f5;color:#363636}.menu-list a.is-active{background-color:#485fc7;color:#fff}.menu-list li ul{border-left:1px solid #dbdbdb;margin:.75em;padding-left:.75em}.menu-label{color:#7a7a7a;font-size:.75em;letter-spacing:.1em;text-transform:uppercase}.menu-label:not(:first-child){margin-top:1em}.menu-label:not(:last-child){margin-bottom:1em}.message{background-color:#f5f5f5;border-radius:4px;font-size:1rem}.message strong{color:currentColor}.message a:not(.button):not(.tag):not(.dropdown-item){color:currentColor;text-decoration:underline}.message.is-small{font-size:.75rem}.message.is-medium{font-size:1.25rem}.message.is-large{font-size:1.5rem}.message.is-white{background-color:#fff}.message.is-white .message-header{background-color:#fff;color:#0a0a0a}.message.is-white .message-body{border-color:#fff}.message.is-black{background-color:#fafafa}.message.is-black .message-header{background-color:#0a0a0a;color:#fff}.message.is-black .message-body{border-color:#0a0a0a}.message.is-light{background-color:#fafafa}.message.is-light .message-header{background-color:#f5f5f5;color:rgba(0,0,0,.7)}.message.is-light .message-body{border-color:#f5f5f5}.message.is-dark{background-color:#fafafa}.message.is-dark .message-header{background-color:#363636;color:#fff}.message.is-dark .message-body{border-color:#363636}.message.is-primary{background-color:#ebfffc}.message.is-primary .message-header{background-color:#00d1b2;color:#fff}.message.is-primary .message-body{border-color:#00d1b2;color:#00947e}.message.is-link{background-color:#eff1fa}.message.is-link .message-header{background-color:#485fc7;color:#fff}.message.is-link .message-body{border-color:#485fc7;color:#3850b7}.message.is-info{background-color:#eff5fb}.message.is-info .message-header{background-color:#3e8ed0;color:#fff}.message.is-info .message-body{border-color:#3e8ed0;color:#296fa8}.message.is-success{background-color:#effaf5}.message.is-success .message-header{background-color:#48c78e;color:#fff}.message.is-success .message-body{border-color:#48c78e;color:#257953}.message.is-warning{background-color:#fffaeb}.message.is-warning .message-header{background-color:#ffe08a;color:rgba(0,0,0,.7)}.message.is-warning .message-body{border-color:#ffe08a;color:#946c00}.message.is-danger{background-color:#feecf0}.message.is-danger .message-header{background-color:#f14668;color:#fff}.message.is-danger .message-body{border-color:#f14668;color:#cc0f35}.message-header{align-items:center;background-color:#4a4a4a;border-radius:4px 4px 0 0;color:#fff;display:flex;font-weight:700;justify-content:space-between;line-height:1.25;padding:.75em 1em;position:relative}.message-header .delete{flex-grow:0;flex-shrink:0;margin-left:.75em}.message-header+.message-body{border-width:0;border-top-left-radius:0;border-top-right-radius:0}.message-body{border-color:#dbdbdb;border-radius:4px;border-style:solid;border-width:0 0 0 4px;color:#4a4a4a;padding:1.25em 1.5em}.message-body code,.message-body pre{background-color:#fff}.message-body pre code{background-color:transparent}.modal{align-items:center;display:none;flex-direction:column;justify-content:center;overflow:hidden;position:fixed;z-index:40}.modal.is-active{display:flex}.modal-background{background-color:rgba(10,10,10,.86)}.modal-card,.modal-content{margin:0 20px;max-height:calc(100vh - 160px);overflow:auto;position:relative;width:100%}@media screen and (min-width:769px){.modal-card,.modal-content{margin:0 auto;max-height:calc(100vh - 40px);width:640px}}.modal-close{background:0 0;height:40px;position:fixed;right:20px;top:20px;width:40px}.modal-card{display:flex;flex-direction:column;max-height:calc(100vh - 40px);overflow:hidden;-ms-overflow-y:visible}.modal-card-foot,.modal-card-head{align-items:center;background-color:#f5f5f5;display:flex;flex-shrink:0;justify-content:flex-start;padding:20px;position:relative}.modal-card-head{border-bottom:1px solid #dbdbdb;border-top-left-radius:6px;border-top-right-radius:6px}.modal-card-title{color:#363636;flex-grow:1;flex-shrink:0;font-size:1.5rem;line-height:1}.modal-card-foot{border-bottom-left-radius:6px;border-bottom-right-radius:6px;border-top:1px solid #dbdbdb}.modal-card-foot .button:not(:last-child){margin-right:.5em}.modal-card-body{-webkit-overflow-scrolling:touch;background-color:#fff;flex-grow:1;flex-shrink:1;overflow:auto;padding:20px}.navbar{background-color:#fff;min-height:3.25rem;position:relative;z-index:30}.navbar.is-white{background-color:#fff;color:#0a0a0a}.navbar.is-white .navbar-brand .navbar-link,.navbar.is-white .navbar-brand>.navbar-item{color:#0a0a0a}.navbar.is-white .navbar-brand .navbar-link.is-active,.navbar.is-white .navbar-brand .navbar-link:focus,.navbar.is-white .navbar-brand .navbar-link:hover,.navbar.is-white .navbar-brand>a.navbar-item.is-active,.navbar.is-white .navbar-brand>a.navbar-item:focus,.navbar.is-white .navbar-brand>a.navbar-item:hover{background-color:#f2f2f2;color:#0a0a0a}.navbar.is-white .navbar-brand .navbar-link::after{border-color:#0a0a0a}.navbar.is-white .navbar-burger{color:#0a0a0a}@media screen and (min-width:1024px){.navbar.is-white .navbar-end .navbar-link,.navbar.is-white .navbar-end>.navbar-item,.navbar.is-white .navbar-start .navbar-link,.navbar.is-white .navbar-start>.navbar-item{color:#0a0a0a}.navbar.is-white .navbar-end .navbar-link.is-active,.navbar.is-white .navbar-end .navbar-link:focus,.navbar.is-white .navbar-end .navbar-link:hover,.navbar.is-white .navbar-end>a.navbar-item.is-active,.navbar.is-white .navbar-end>a.navbar-item:focus,.navbar.is-white .navbar-end>a.navbar-item:hover,.navbar.is-white .navbar-start .navbar-link.is-active,.navbar.is-white .navbar-start .navbar-link:focus,.navbar.is-white .navbar-start .navbar-link:hover,.navbar.is-white .navbar-start>a.navbar-item.is-active,.navbar.is-white .navbar-start>a.navbar-item:focus,.navbar.is-white .navbar-start>a.navbar-item:hover{background-color:#f2f2f2;color:#0a0a0a}.navbar.is-white .navbar-end .navbar-link::after,.navbar.is-white .navbar-start .navbar-link::after{border-color:#0a0a0a}.navbar.is-white .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-white .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-white .navbar-item.has-dropdown:hover .navbar-link{background-color:#f2f2f2;color:#0a0a0a}.navbar.is-white .navbar-dropdown a.navbar-item.is-active{background-color:#fff;color:#0a0a0a}}.navbar.is-black{background-color:#0a0a0a;color:#fff}.navbar.is-black .navbar-brand .navbar-link,.navbar.is-black .navbar-brand>.navbar-item{color:#fff}.navbar.is-black .navbar-brand .navbar-link.is-active,.navbar.is-black .navbar-brand .navbar-link:focus,.navbar.is-black .navbar-brand .navbar-link:hover,.navbar.is-black .navbar-brand>a.navbar-item.is-active,.navbar.is-black .navbar-brand>a.navbar-item:focus,.navbar.is-black .navbar-brand>a.navbar-item:hover{background-color:#000;color:#fff}.navbar.is-black .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-black .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-black .navbar-end .navbar-link,.navbar.is-black .navbar-end>.navbar-item,.navbar.is-black .navbar-start .navbar-link,.navbar.is-black .navbar-start>.navbar-item{color:#fff}.navbar.is-black .navbar-end .navbar-link.is-active,.navbar.is-black .navbar-end .navbar-link:focus,.navbar.is-black .navbar-end .navbar-link:hover,.navbar.is-black .navbar-end>a.navbar-item.is-active,.navbar.is-black .navbar-end>a.navbar-item:focus,.navbar.is-black .navbar-end>a.navbar-item:hover,.navbar.is-black .navbar-start .navbar-link.is-active,.navbar.is-black .navbar-start .navbar-link:focus,.navbar.is-black .navbar-start .navbar-link:hover,.navbar.is-black .navbar-start>a.navbar-item.is-active,.navbar.is-black .navbar-start>a.navbar-item:focus,.navbar.is-black .navbar-start>a.navbar-item:hover{background-color:#000;color:#fff}.navbar.is-black .navbar-end .navbar-link::after,.navbar.is-black .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-black .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-black .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-black .navbar-item.has-dropdown:hover .navbar-link{background-color:#000;color:#fff}.navbar.is-black .navbar-dropdown a.navbar-item.is-active{background-color:#0a0a0a;color:#fff}}.navbar.is-light{background-color:#f5f5f5;color:rgba(0,0,0,.7)}.navbar.is-light .navbar-brand .navbar-link,.navbar.is-light .navbar-brand>.navbar-item{color:rgba(0,0,0,.7)}.navbar.is-light .navbar-brand .navbar-link.is-active,.navbar.is-light .navbar-brand .navbar-link:focus,.navbar.is-light .navbar-brand .navbar-link:hover,.navbar.is-light .navbar-brand>a.navbar-item.is-active,.navbar.is-light .navbar-brand>a.navbar-item:focus,.navbar.is-light .navbar-brand>a.navbar-item:hover{background-color:#e8e8e8;color:rgba(0,0,0,.7)}.navbar.is-light .navbar-brand .navbar-link::after{border-color:rgba(0,0,0,.7)}.navbar.is-light .navbar-burger{color:rgba(0,0,0,.7)}@media screen and (min-width:1024px){.navbar.is-light .navbar-end .navbar-link,.navbar.is-light .navbar-end>.navbar-item,.navbar.is-light .navbar-start .navbar-link,.navbar.is-light .navbar-start>.navbar-item{color:rgba(0,0,0,.7)}.navbar.is-light .navbar-end .navbar-link.is-active,.navbar.is-light .navbar-end .navbar-link:focus,.navbar.is-light .navbar-end .navbar-link:hover,.navbar.is-light .navbar-end>a.navbar-item.is-active,.navbar.is-light .navbar-end>a.navbar-item:focus,.navbar.is-light .navbar-end>a.navbar-item:hover,.navbar.is-light .navbar-start .navbar-link.is-active,.navbar.is-light .navbar-start .navbar-link:focus,.navbar.is-light .navbar-start .navbar-link:hover,.navbar.is-light .navbar-start>a.navbar-item.is-active,.navbar.is-light .navbar-start>a.navbar-item:focus,.navbar.is-light .navbar-start>a.navbar-item:hover{background-color:#e8e8e8;color:rgba(0,0,0,.7)}.navbar.is-light .navbar-end .navbar-link::after,.navbar.is-light .navbar-start .navbar-link::after{border-color:rgba(0,0,0,.7)}.navbar.is-light .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-light .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-light .navbar-item.has-dropdown:hover .navbar-link{background-color:#e8e8e8;color:rgba(0,0,0,.7)}.navbar.is-light .navbar-dropdown a.navbar-item.is-active{background-color:#f5f5f5;color:rgba(0,0,0,.7)}}.navbar.is-dark{background-color:#363636;color:#fff}.navbar.is-dark .navbar-brand .navbar-link,.navbar.is-dark .navbar-brand>.navbar-item{color:#fff}.navbar.is-dark .navbar-brand .navbar-link.is-active,.navbar.is-dark .navbar-brand .navbar-link:focus,.navbar.is-dark .navbar-brand .navbar-link:hover,.navbar.is-dark .navbar-brand>a.navbar-item.is-active,.navbar.is-dark .navbar-brand>a.navbar-item:focus,.navbar.is-dark .navbar-brand>a.navbar-item:hover{background-color:#292929;color:#fff}.navbar.is-dark .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-dark .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-dark .navbar-end .navbar-link,.navbar.is-dark .navbar-end>.navbar-item,.navbar.is-dark .navbar-start .navbar-link,.navbar.is-dark .navbar-start>.navbar-item{color:#fff}.navbar.is-dark .navbar-end .navbar-link.is-active,.navbar.is-dark .navbar-end .navbar-link:focus,.navbar.is-dark .navbar-end .navbar-link:hover,.navbar.is-dark .navbar-end>a.navbar-item.is-active,.navbar.is-dark .navbar-end>a.navbar-item:focus,.navbar.is-dark .navbar-end>a.navbar-item:hover,.navbar.is-dark .navbar-start .navbar-link.is-active,.navbar.is-dark .navbar-start .navbar-link:focus,.navbar.is-dark .navbar-start .navbar-link:hover,.navbar.is-dark .navbar-start>a.navbar-item.is-active,.navbar.is-dark .navbar-start>a.navbar-item:focus,.navbar.is-dark .navbar-start>a.navbar-item:hover{background-color:#292929;color:#fff}.navbar.is-dark .navbar-end .navbar-link::after,.navbar.is-dark .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-dark .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-dark .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-dark .navbar-item.has-dropdown:hover .navbar-link{background-color:#292929;color:#fff}.navbar.is-dark .navbar-dropdown a.navbar-item.is-active{background-color:#363636;color:#fff}}.navbar.is-primary{background-color:#00d1b2;color:#fff}.navbar.is-primary .navbar-brand .navbar-link,.navbar.is-primary .navbar-brand>.navbar-item{color:#fff}.navbar.is-primary .navbar-brand .navbar-link.is-active,.navbar.is-primary .navbar-brand .navbar-link:focus,.navbar.is-primary .navbar-brand .navbar-link:hover,.navbar.is-primary .navbar-brand>a.navbar-item.is-active,.navbar.is-primary .navbar-brand>a.navbar-item:focus,.navbar.is-primary .navbar-brand>a.navbar-item:hover{background-color:#00b89c;color:#fff}.navbar.is-primary .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-primary .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-primary .navbar-end .navbar-link,.navbar.is-primary .navbar-end>.navbar-item,.navbar.is-primary .navbar-start .navbar-link,.navbar.is-primary .navbar-start>.navbar-item{color:#fff}.navbar.is-primary .navbar-end .navbar-link.is-active,.navbar.is-primary .navbar-end .navbar-link:focus,.navbar.is-primary .navbar-end .navbar-link:hover,.navbar.is-primary .navbar-end>a.navbar-item.is-active,.navbar.is-primary .navbar-end>a.navbar-item:focus,.navbar.is-primary .navbar-end>a.navbar-item:hover,.navbar.is-primary .navbar-start .navbar-link.is-active,.navbar.is-primary .navbar-start .navbar-link:focus,.navbar.is-primary .navbar-start .navbar-link:hover,.navbar.is-primary .navbar-start>a.navbar-item.is-active,.navbar.is-primary .navbar-start>a.navbar-item:focus,.navbar.is-primary .navbar-start>a.navbar-item:hover{background-color:#00b89c;color:#fff}.navbar.is-primary .navbar-end .navbar-link::after,.navbar.is-primary .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-primary .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-primary .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-primary .navbar-item.has-dropdown:hover .navbar-link{background-color:#00b89c;color:#fff}.navbar.is-primary .navbar-dropdown a.navbar-item.is-active{background-color:#00d1b2;color:#fff}}.navbar.is-link{background-color:#485fc7;color:#fff}.navbar.is-link .navbar-brand .navbar-link,.navbar.is-link .navbar-brand>.navbar-item{color:#fff}.navbar.is-link .navbar-brand .navbar-link.is-active,.navbar.is-link .navbar-brand .navbar-link:focus,.navbar.is-link .navbar-brand .navbar-link:hover,.navbar.is-link .navbar-brand>a.navbar-item.is-active,.navbar.is-link .navbar-brand>a.navbar-item:focus,.navbar.is-link .navbar-brand>a.navbar-item:hover{background-color:#3a51bb;color:#fff}.navbar.is-link .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-link .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-link .navbar-end .navbar-link,.navbar.is-link .navbar-end>.navbar-item,.navbar.is-link .navbar-start .navbar-link,.navbar.is-link .navbar-start>.navbar-item{color:#fff}.navbar.is-link .navbar-end .navbar-link.is-active,.navbar.is-link .navbar-end .navbar-link:focus,.navbar.is-link .navbar-end .navbar-link:hover,.navbar.is-link .navbar-end>a.navbar-item.is-active,.navbar.is-link .navbar-end>a.navbar-item:focus,.navbar.is-link .navbar-end>a.navbar-item:hover,.navbar.is-link .navbar-start .navbar-link.is-active,.navbar.is-link .navbar-start .navbar-link:focus,.navbar.is-link .navbar-start .navbar-link:hover,.navbar.is-link .navbar-start>a.navbar-item.is-active,.navbar.is-link .navbar-start>a.navbar-item:focus,.navbar.is-link .navbar-start>a.navbar-item:hover{background-color:#3a51bb;color:#fff}.navbar.is-link .navbar-end .navbar-link::after,.navbar.is-link .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-link .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-link .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-link .navbar-item.has-dropdown:hover .navbar-link{background-color:#3a51bb;color:#fff}.navbar.is-link .navbar-dropdown a.navbar-item.is-active{background-color:#485fc7;color:#fff}}.navbar.is-info{background-color:#3e8ed0;color:#fff}.navbar.is-info .navbar-brand .navbar-link,.navbar.is-info .navbar-brand>.navbar-item{color:#fff}.navbar.is-info .navbar-brand .navbar-link.is-active,.navbar.is-info .navbar-brand .navbar-link:focus,.navbar.is-info .navbar-brand .navbar-link:hover,.navbar.is-info .navbar-brand>a.navbar-item.is-active,.navbar.is-info .navbar-brand>a.navbar-item:focus,.navbar.is-info .navbar-brand>a.navbar-item:hover{background-color:#3082c5;color:#fff}.navbar.is-info .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-info .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-info .navbar-end .navbar-link,.navbar.is-info .navbar-end>.navbar-item,.navbar.is-info .navbar-start .navbar-link,.navbar.is-info .navbar-start>.navbar-item{color:#fff}.navbar.is-info .navbar-end .navbar-link.is-active,.navbar.is-info .navbar-end .navbar-link:focus,.navbar.is-info .navbar-end .navbar-link:hover,.navbar.is-info .navbar-end>a.navbar-item.is-active,.navbar.is-info .navbar-end>a.navbar-item:focus,.navbar.is-info .navbar-end>a.navbar-item:hover,.navbar.is-info .navbar-start .navbar-link.is-active,.navbar.is-info .navbar-start .navbar-link:focus,.navbar.is-info .navbar-start .navbar-link:hover,.navbar.is-info .navbar-start>a.navbar-item.is-active,.navbar.is-info .navbar-start>a.navbar-item:focus,.navbar.is-info .navbar-start>a.navbar-item:hover{background-color:#3082c5;color:#fff}.navbar.is-info .navbar-end .navbar-link::after,.navbar.is-info .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-info .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-info .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-info .navbar-item.has-dropdown:hover .navbar-link{background-color:#3082c5;color:#fff}.navbar.is-info .navbar-dropdown a.navbar-item.is-active{background-color:#3e8ed0;color:#fff}}.navbar.is-success{background-color:#48c78e;color:#fff}.navbar.is-success .navbar-brand .navbar-link,.navbar.is-success .navbar-brand>.navbar-item{color:#fff}.navbar.is-success .navbar-brand .navbar-link.is-active,.navbar.is-success .navbar-brand .navbar-link:focus,.navbar.is-success .navbar-brand .navbar-link:hover,.navbar.is-success .navbar-brand>a.navbar-item.is-active,.navbar.is-success .navbar-brand>a.navbar-item:focus,.navbar.is-success .navbar-brand>a.navbar-item:hover{background-color:#3abb81;color:#fff}.navbar.is-success .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-success .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-success .navbar-end .navbar-link,.navbar.is-success .navbar-end>.navbar-item,.navbar.is-success .navbar-start .navbar-link,.navbar.is-success .navbar-start>.navbar-item{color:#fff}.navbar.is-success .navbar-end .navbar-link.is-active,.navbar.is-success .navbar-end .navbar-link:focus,.navbar.is-success .navbar-end .navbar-link:hover,.navbar.is-success .navbar-end>a.navbar-item.is-active,.navbar.is-success .navbar-end>a.navbar-item:focus,.navbar.is-success .navbar-end>a.navbar-item:hover,.navbar.is-success .navbar-start .navbar-link.is-active,.navbar.is-success .navbar-start .navbar-link:focus,.navbar.is-success .navbar-start .navbar-link:hover,.navbar.is-success .navbar-start>a.navbar-item.is-active,.navbar.is-success .navbar-start>a.navbar-item:focus,.navbar.is-success .navbar-start>a.navbar-item:hover{background-color:#3abb81;color:#fff}.navbar.is-success .navbar-end .navbar-link::after,.navbar.is-success .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-success .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-success .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-success .navbar-item.has-dropdown:hover .navbar-link{background-color:#3abb81;color:#fff}.navbar.is-success .navbar-dropdown a.navbar-item.is-active{background-color:#48c78e;color:#fff}}.navbar.is-warning{background-color:#ffe08a;color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-brand .navbar-link,.navbar.is-warning .navbar-brand>.navbar-item{color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-brand .navbar-link.is-active,.navbar.is-warning .navbar-brand .navbar-link:focus,.navbar.is-warning .navbar-brand .navbar-link:hover,.navbar.is-warning .navbar-brand>a.navbar-item.is-active,.navbar.is-warning .navbar-brand>a.navbar-item:focus,.navbar.is-warning .navbar-brand>a.navbar-item:hover{background-color:#ffd970;color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-brand .navbar-link::after{border-color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-burger{color:rgba(0,0,0,.7)}@media screen and (min-width:1024px){.navbar.is-warning .navbar-end .navbar-link,.navbar.is-warning .navbar-end>.navbar-item,.navbar.is-warning .navbar-start .navbar-link,.navbar.is-warning .navbar-start>.navbar-item{color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-end .navbar-link.is-active,.navbar.is-warning .navbar-end .navbar-link:focus,.navbar.is-warning .navbar-end .navbar-link:hover,.navbar.is-warning .navbar-end>a.navbar-item.is-active,.navbar.is-warning .navbar-end>a.navbar-item:focus,.navbar.is-warning .navbar-end>a.navbar-item:hover,.navbar.is-warning .navbar-start .navbar-link.is-active,.navbar.is-warning .navbar-start .navbar-link:focus,.navbar.is-warning .navbar-start .navbar-link:hover,.navbar.is-warning .navbar-start>a.navbar-item.is-active,.navbar.is-warning .navbar-start>a.navbar-item:focus,.navbar.is-warning .navbar-start>a.navbar-item:hover{background-color:#ffd970;color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-end .navbar-link::after,.navbar.is-warning .navbar-start .navbar-link::after{border-color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-warning .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-warning .navbar-item.has-dropdown:hover .navbar-link{background-color:#ffd970;color:rgba(0,0,0,.7)}.navbar.is-warning .navbar-dropdown a.navbar-item.is-active{background-color:#ffe08a;color:rgba(0,0,0,.7)}}.navbar.is-danger{background-color:#f14668;color:#fff}.navbar.is-danger .navbar-brand .navbar-link,.navbar.is-danger .navbar-brand>.navbar-item{color:#fff}.navbar.is-danger .navbar-brand .navbar-link.is-active,.navbar.is-danger .navbar-brand .navbar-link:focus,.navbar.is-danger .navbar-brand .navbar-link:hover,.navbar.is-danger .navbar-brand>a.navbar-item.is-active,.navbar.is-danger .navbar-brand>a.navbar-item:focus,.navbar.is-danger .navbar-brand>a.navbar-item:hover{background-color:#ef2e55;color:#fff}.navbar.is-danger .navbar-brand .navbar-link::after{border-color:#fff}.navbar.is-danger .navbar-burger{color:#fff}@media screen and (min-width:1024px){.navbar.is-danger .navbar-end .navbar-link,.navbar.is-danger .navbar-end>.navbar-item,.navbar.is-danger .navbar-start .navbar-link,.navbar.is-danger .navbar-start>.navbar-item{color:#fff}.navbar.is-danger .navbar-end .navbar-link.is-active,.navbar.is-danger .navbar-end .navbar-link:focus,.navbar.is-danger .navbar-end .navbar-link:hover,.navbar.is-danger .navbar-end>a.navbar-item.is-active,.navbar.is-danger .navbar-end>a.navbar-item:focus,.navbar.is-danger .navbar-end>a.navbar-item:hover,.navbar.is-danger .navbar-start .navbar-link.is-active,.navbar.is-danger .navbar-start .navbar-link:focus,.navbar.is-danger .navbar-start .navbar-link:hover,.navbar.is-danger .navbar-start>a.navbar-item.is-active,.navbar.is-danger .navbar-start>a.navbar-item:focus,.navbar.is-danger .navbar-start>a.navbar-item:hover{background-color:#ef2e55;color:#fff}.navbar.is-danger .navbar-end .navbar-link::after,.navbar.is-danger .navbar-start .navbar-link::after{border-color:#fff}.navbar.is-danger .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-danger .navbar-item.has-dropdown:focus .navbar-link,.navbar.is-danger .navbar-item.has-dropdown:hover .navbar-link{background-color:#ef2e55;color:#fff}.navbar.is-danger .navbar-dropdown a.navbar-item.is-active{background-color:#f14668;color:#fff}}.navbar>.container{align-items:stretch;display:flex;min-height:3.25rem;width:100%}.navbar.has-shadow{box-shadow:0 2px 0 0 #f5f5f5}.navbar.is-fixed-bottom,.navbar.is-fixed-top{left:0;position:fixed;right:0;z-index:30}.navbar.is-fixed-bottom{bottom:0}.navbar.is-fixed-bottom.has-shadow{box-shadow:0 -2px 0 0 #f5f5f5}.navbar.is-fixed-top{top:0}body.has-navbar-fixed-top,html.has-navbar-fixed-top{padding-top:3.25rem}body.has-navbar-fixed-bottom,html.has-navbar-fixed-bottom{padding-bottom:3.25rem}.navbar-brand,.navbar-tabs{align-items:stretch;display:flex;flex-shrink:0;min-height:3.25rem}.navbar-brand a.navbar-item:focus,.navbar-brand a.navbar-item:hover{background-color:transparent}.navbar-tabs{-webkit-overflow-scrolling:touch;max-width:100vw;overflow-x:auto;overflow-y:hidden}.navbar-burger{color:#4a4a4a;-moz-appearance:none;-webkit-appearance:none;appearance:none;background:0 0;border:none;cursor:pointer;display:block;height:3.25rem;position:relative;width:3.25rem;margin-left:auto}.navbar-burger span{background-color:currentColor;display:block;height:1px;left:calc(50% - 8px);position:absolute;transform-origin:center;transition-duration:86ms;transition-property:background-color,opacity,transform;transition-timing-function:ease-out;width:16px}.navbar-burger span:first-child{top:calc(50% - 6px)}.navbar-burger span:nth-child(2){top:calc(50% - 1px)}.navbar-burger span:nth-child(3){top:calc(50% + 4px)}.navbar-burger:hover{background-color:rgba(0,0,0,.05)}.navbar-burger.is-active span:first-child{transform:translateY(5px) rotate(45deg)}.navbar-burger.is-active span:nth-child(2){opacity:0}.navbar-burger.is-active span:nth-child(3){transform:translateY(-5px) rotate(-45deg)}.navbar-menu{display:none}.navbar-item,.navbar-link{color:#4a4a4a;display:block;line-height:1.5;padding:.5rem .75rem;position:relative}.navbar-item .icon:only-child,.navbar-link .icon:only-child{margin-left:-.25rem;margin-right:-.25rem}.navbar-link,a.navbar-item{cursor:pointer}.navbar-link.is-active,.navbar-link:focus,.navbar-link:focus-within,.navbar-link:hover,a.navbar-item.is-active,a.navbar-item:focus,a.navbar-item:focus-within,a.navbar-item:hover{background-color:#fafafa;color:#485fc7}.navbar-item{flex-grow:0;flex-shrink:0}.navbar-item img{max-height:1.75rem}.navbar-item.has-dropdown{padding:0}.navbar-item.is-expanded{flex-grow:1;flex-shrink:1}.navbar-item.is-tab{border-bottom:1px solid transparent;min-height:3.25rem;padding-bottom:calc(.5rem - 1px)}.navbar-item.is-tab:focus,.navbar-item.is-tab:hover{background-color:transparent;border-bottom-color:#485fc7}.navbar-item.is-tab.is-active{background-color:transparent;border-bottom-color:#485fc7;border-bottom-style:solid;border-bottom-width:3px;color:#485fc7;padding-bottom:calc(.5rem - 3px)}.navbar-content{flex-grow:1;flex-shrink:1}.navbar-link:not(.is-arrowless){padding-right:2.5em}.navbar-link:not(.is-arrowless)::after{border-color:#485fc7;margin-top:-.375em;right:1.125em}.navbar-dropdown{font-size:.875rem;padding-bottom:.5rem;padding-top:.5rem}.navbar-dropdown .navbar-item{padding-left:1.5rem;padding-right:1.5rem}.navbar-divider{background-color:#f5f5f5;border:none;display:none;height:2px;margin:.5rem 0}@media screen and (max-width:1023px){.navbar>.container{display:block}.navbar-brand .navbar-item,.navbar-tabs .navbar-item{align-items:center;display:flex}.navbar-link::after{display:none}.navbar-menu{background-color:#fff;box-shadow:0 8px 16px rgba(10,10,10,.1);padding:.5rem 0}.navbar-menu.is-active{display:block}.navbar.is-fixed-bottom-touch,.navbar.is-fixed-top-touch{left:0;position:fixed;right:0;z-index:30}.navbar.is-fixed-bottom-touch{bottom:0}.navbar.is-fixed-bottom-touch.has-shadow{box-shadow:0 -2px 3px rgba(10,10,10,.1)}.navbar.is-fixed-top-touch{top:0}.navbar.is-fixed-top .navbar-menu,.navbar.is-fixed-top-touch .navbar-menu{-webkit-overflow-scrolling:touch;max-height:calc(100vh - 3.25rem);overflow:auto}body.has-navbar-fixed-top-touch,html.has-navbar-fixed-top-touch{padding-top:3.25rem}body.has-navbar-fixed-bottom-touch,html.has-navbar-fixed-bottom-touch{padding-bottom:3.25rem}}@media screen and (min-width:1024px){.navbar,.navbar-end,.navbar-menu,.navbar-start{align-items:stretch;display:flex}.navbar{min-height:3.25rem}.navbar.is-spaced{padding:1rem 2rem}.navbar.is-spaced .navbar-end,.navbar.is-spaced .navbar-start{align-items:center}.navbar.is-spaced .navbar-link,.navbar.is-spaced a.navbar-item{border-radius:4px}.navbar.is-transparent .navbar-link.is-active,.navbar.is-transparent .navbar-link:focus,.navbar.is-transparent .navbar-link:hover,.navbar.is-transparent a.navbar-item.is-active,.navbar.is-transparent a.navbar-item:focus,.navbar.is-transparent a.navbar-item:hover{background-color:transparent!important}.navbar.is-transparent .navbar-item.has-dropdown.is-active .navbar-link,.navbar.is-transparent .navbar-item.has-dropdown.is-hoverable:focus .navbar-link,.navbar.is-transparent .navbar-item.has-dropdown.is-hoverable:focus-within .navbar-link,.navbar.is-transparent .navbar-item.has-dropdown.is-hoverable:hover .navbar-link{background-color:transparent!important}.navbar.is-transparent .navbar-dropdown a.navbar-item:focus,.navbar.is-transparent .navbar-dropdown a.navbar-item:hover{background-color:#f5f5f5;color:#0a0a0a}.navbar.is-transparent .navbar-dropdown a.navbar-item.is-active{background-color:#f5f5f5;color:#485fc7}.navbar-burger{display:none}.navbar-item,.navbar-link{align-items:center;display:flex}.navbar-item.has-dropdown{align-items:stretch}.navbar-item.has-dropdown-up .navbar-link::after{transform:rotate(135deg) translate(.25em,-.25em)}.navbar-item.has-dropdown-up .navbar-dropdown{border-bottom:2px solid #dbdbdb;border-radius:6px 6px 0 0;border-top:none;bottom:100%;box-shadow:0 -8px 8px rgba(10,10,10,.1);top:auto}.navbar-item.is-active .navbar-dropdown,.navbar-item.is-hoverable:focus .navbar-dropdown,.navbar-item.is-hoverable:focus-within .navbar-dropdown,.navbar-item.is-hoverable:hover .navbar-dropdown{display:block}.navbar-item.is-active .navbar-dropdown.is-boxed,.navbar-item.is-hoverable:focus .navbar-dropdown.is-boxed,.navbar-item.is-hoverable:focus-within .navbar-dropdown.is-boxed,.navbar-item.is-hoverable:hover .navbar-dropdown.is-boxed,.navbar.is-spaced .navbar-item.is-active .navbar-dropdown,.navbar.is-spaced .navbar-item.is-hoverable:focus .navbar-dropdown,.navbar.is-spaced .navbar-item.is-hoverable:focus-within .navbar-dropdown,.navbar.is-spaced .navbar-item.is-hoverable:hover .navbar-dropdown{opacity:1;pointer-events:auto;transform:translateY(0)}.navbar-menu{flex-grow:1;flex-shrink:0}.navbar-start{justify-content:flex-start;margin-right:auto}.navbar-end{justify-content:flex-end;margin-left:auto}.navbar-dropdown{background-color:#fff;border-bottom-left-radius:6px;border-bottom-right-radius:6px;border-top:2px solid #dbdbdb;box-shadow:0 8px 8px rgba(10,10,10,.1);display:none;font-size:.875rem;left:0;min-width:100%;position:absolute;top:100%;z-index:20}.navbar-dropdown .navbar-item{padding:.375rem 1rem;white-space:nowrap}.navbar-dropdown a.navbar-item{padding-right:3rem}.navbar-dropdown a.navbar-item:focus,.navbar-dropdown a.navbar-item:hover{background-color:#f5f5f5;color:#0a0a0a}.navbar-dropdown a.navbar-item.is-active{background-color:#f5f5f5;color:#485fc7}.navbar-dropdown.is-boxed,.navbar.is-spaced .navbar-dropdown{border-radius:6px;border-top:none;box-shadow:0 8px 8px rgba(10,10,10,.1),0 0 0 1px rgba(10,10,10,.1);display:block;opacity:0;pointer-events:none;top:calc(100% + (-4px));transform:translateY(-5px);transition-duration:86ms;transition-property:opacity,transform}.navbar-dropdown.is-right{left:auto;right:0}.navbar-divider{display:block}.container>.navbar .navbar-brand,.navbar>.container .navbar-brand{margin-left:-.75rem}.container>.navbar .navbar-menu,.navbar>.container .navbar-menu{margin-right:-.75rem}.navbar.is-fixed-bottom-desktop,.navbar.is-fixed-top-desktop{left:0;position:fixed;right:0;z-index:30}.navbar.is-fixed-bottom-desktop{bottom:0}.navbar.is-fixed-bottom-desktop.has-shadow{box-shadow:0 -2px 3px rgba(10,10,10,.1)}.navbar.is-fixed-top-desktop{top:0}body.has-navbar-fixed-top-desktop,html.has-navbar-fixed-top-desktop{padding-top:3.25rem}body.has-navbar-fixed-bottom-desktop,html.has-navbar-fixed-bottom-desktop{padding-bottom:3.25rem}body.has-spaced-navbar-fixed-top,html.has-spaced-navbar-fixed-top{padding-top:5.25rem}body.has-spaced-navbar-fixed-bottom,html.has-spaced-navbar-fixed-bottom{padding-bottom:5.25rem}.navbar-link.is-active,a.navbar-item.is-active{color:#0a0a0a}.navbar-link.is-active:not(:focus):not(:hover),a.navbar-item.is-active:not(:focus):not(:hover){background-color:transparent}.navbar-item.has-dropdown.is-active .navbar-link,.navbar-item.has-dropdown:focus .navbar-link,.navbar-item.has-dropdown:hover .navbar-link{background-color:#fafafa}}.hero.is-fullheight-with-navbar{min-height:calc(100vh - 3.25rem)}.pagination{font-size:1rem;margin:-.25rem}.pagination.is-small{font-size:.75rem}.pagination.is-medium{font-size:1.25rem}.pagination.is-large{font-size:1.5rem}.pagination.is-rounded .pagination-next,.pagination.is-rounded .pagination-previous{padding-left:1em;padding-right:1em;border-radius:9999px}.pagination.is-rounded .pagination-link{border-radius:9999px}.pagination,.pagination-list{align-items:center;display:flex;justify-content:center;text-align:center}.pagination-ellipsis,.pagination-link,.pagination-next,.pagination-previous{font-size:1em;justify-content:center;margin:.25rem;padding-left:.5em;padding-right:.5em;text-align:center}.pagination-link,.pagination-next,.pagination-previous{border-color:#dbdbdb;color:#363636;min-width:2.5em}.pagination-link:hover,.pagination-next:hover,.pagination-previous:hover{border-color:#b5b5b5;color:#363636}.pagination-link:focus,.pagination-next:focus,.pagination-previous:focus{border-color:#485fc7}.pagination-link:active,.pagination-next:active,.pagination-previous:active{box-shadow:inset 0 1px 2px rgba(10,10,10,.2)}.pagination-link.is-disabled,.pagination-link[disabled],.pagination-next.is-disabled,.pagination-next[disabled],.pagination-previous.is-disabled,.pagination-previous[disabled]{background-color:#dbdbdb;border-color:#dbdbdb;box-shadow:none;color:#7a7a7a;opacity:.5}.pagination-next,.pagination-previous{padding-left:.75em;padding-right:.75em;white-space:nowrap}.pagination-link.is-current{background-color:#485fc7;border-color:#485fc7;color:#fff}.pagination-ellipsis{color:#b5b5b5;pointer-events:none}.pagination-list{flex-wrap:wrap}.pagination-list li{list-style:none}@media screen and (max-width:768px){.pagination{flex-wrap:wrap}.pagination-next,.pagination-previous{flex-grow:1;flex-shrink:1}.pagination-list li{flex-grow:1;flex-shrink:1}}@media screen and (min-width:769px),print{.pagination-list{flex-grow:1;flex-shrink:1;justify-content:flex-start;order:1}.pagination-ellipsis,.pagination-link,.pagination-next,.pagination-previous{margin-bottom:0;margin-top:0}.pagination-previous{order:2}.pagination-next{order:3}.pagination{justify-content:space-between;margin-bottom:0;margin-top:0}.pagination.is-centered .pagination-previous{order:1}.pagination.is-centered .pagination-list{justify-content:center;order:2}.pagination.is-centered .pagination-next{order:3}.pagination.is-right .pagination-previous{order:1}.pagination.is-right .pagination-next{order:2}.pagination.is-right .pagination-list{justify-content:flex-end;order:3}}.panel{border-radius:6px;box-shadow:0 .5em 1em -.125em rgba(10,10,10,.1),0 0 0 1px rgba(10,10,10,.02);font-size:1rem}.panel:not(:last-child){margin-bottom:1.5rem}.panel.is-white .panel-heading{background-color:#fff;color:#0a0a0a}.panel.is-white .panel-tabs a.is-active{border-bottom-color:#fff}.panel.is-white .panel-block.is-active .panel-icon{color:#fff}.panel.is-black .panel-heading{background-color:#0a0a0a;color:#fff}.panel.is-black .panel-tabs a.is-active{border-bottom-color:#0a0a0a}.panel.is-black .panel-block.is-active .panel-icon{color:#0a0a0a}.panel.is-light .panel-heading{background-color:#f5f5f5;color:rgba(0,0,0,.7)}.panel.is-light .panel-tabs a.is-active{border-bottom-color:#f5f5f5}.panel.is-light .panel-block.is-active .panel-icon{color:#f5f5f5}.panel.is-dark .panel-heading{background-color:#363636;color:#fff}.panel.is-dark .panel-tabs a.is-active{border-bottom-color:#363636}.panel.is-dark .panel-block.is-active .panel-icon{color:#363636}.panel.is-primary .panel-heading{background-color:#00d1b2;color:#fff}.panel.is-primary .panel-tabs a.is-active{border-bottom-color:#00d1b2}.panel.is-primary .panel-block.is-active .panel-icon{color:#00d1b2}.panel.is-link .panel-heading{background-color:#485fc7;color:#fff}.panel.is-link .panel-tabs a.is-active{border-bottom-color:#485fc7}.panel.is-link .panel-block.is-active .panel-icon{color:#485fc7}.panel.is-info .panel-heading{background-color:#3e8ed0;color:#fff}.panel.is-info .panel-tabs a.is-active{border-bottom-color:#3e8ed0}.panel.is-info .panel-block.is-active .panel-icon{color:#3e8ed0}.panel.is-success .panel-heading{background-color:#48c78e;color:#fff}.panel.is-success .panel-tabs a.is-active{border-bottom-color:#48c78e}.panel.is-success .panel-block.is-active .panel-icon{color:#48c78e}.panel.is-warning .panel-heading{background-color:#ffe08a;color:rgba(0,0,0,.7)}.panel.is-warning .panel-tabs a.is-active{border-bottom-color:#ffe08a}.panel.is-warning .panel-block.is-active .panel-icon{color:#ffe08a}.panel.is-danger .panel-heading{background-color:#f14668;color:#fff}.panel.is-danger .panel-tabs a.is-active{border-bottom-color:#f14668}.panel.is-danger .panel-block.is-active .panel-icon{color:#f14668}.panel-block:not(:last-child),.panel-tabs:not(:last-child){border-bottom:1px solid #ededed}.panel-heading{background-color:#ededed;border-radius:6px 6px 0 0;color:#363636;font-size:1.25em;font-weight:700;line-height:1.25;padding:.75em 1em}.panel-tabs{align-items:flex-end;display:flex;font-size:.875em;justify-content:center}.panel-tabs a{border-bottom:1px solid #dbdbdb;margin-bottom:-1px;padding:.5em}.panel-tabs a.is-active{border-bottom-color:#4a4a4a;color:#363636}.panel-list a{color:#4a4a4a}.panel-list a:hover{color:#485fc7}.panel-block{align-items:center;color:#363636;display:flex;justify-content:flex-start;padding:.5em .75em}.panel-block input[type=checkbox]{margin-right:.75em}.panel-block>.control{flex-grow:1;flex-shrink:1;width:100%}.panel-block.is-wrapped{flex-wrap:wrap}.panel-block.is-active{border-left-color:#485fc7;color:#363636}.panel-block.is-active .panel-icon{color:#485fc7}.panel-block:last-child{border-bottom-left-radius:6px;border-bottom-right-radius:6px}a.panel-block,label.panel-block{cursor:pointer}a.panel-block:hover,label.panel-block:hover{background-color:#f5f5f5}.panel-icon{display:inline-block;font-size:14px;height:1em;line-height:1em;text-align:center;vertical-align:top;width:1em;color:#7a7a7a;margin-right:.75em}.panel-icon .fa{font-size:inherit;line-height:inherit}.tabs{-webkit-overflow-scrolling:touch;align-items:stretch;display:flex;font-size:1rem;justify-content:space-between;overflow:hidden;overflow-x:auto;white-space:nowrap}.tabs a{align-items:center;border-bottom-color:#dbdbdb;border-bottom-style:solid;border-bottom-width:1px;color:#4a4a4a;display:flex;justify-content:center;margin-bottom:-1px;padding:.5em 1em;vertical-align:top}.tabs a:hover{border-bottom-color:#363636;color:#363636}.tabs li{display:block}.tabs li.is-active a{border-bottom-color:#485fc7;color:#485fc7}.tabs ul{align-items:center;border-bottom-color:#dbdbdb;border-bottom-style:solid;border-bottom-width:1px;display:flex;flex-grow:1;flex-shrink:0;justify-content:flex-start}.tabs ul.is-left{padding-right:.75em}.tabs ul.is-center{flex:none;justify-content:center;padding-left:.75em;padding-right:.75em}.tabs ul.is-right{justify-content:flex-end;padding-left:.75em}.tabs .icon:first-child{margin-right:.5em}.tabs .icon:last-child{margin-left:.5em}.tabs.is-centered ul{justify-content:center}.tabs.is-right ul{justify-content:flex-end}.tabs.is-boxed a{border:1px solid transparent;border-radius:4px 4px 0 0}.tabs.is-boxed a:hover{background-color:#f5f5f5;border-bottom-color:#dbdbdb}.tabs.is-boxed li.is-active a{background-color:#fff;border-color:#dbdbdb;border-bottom-color:transparent!important}.tabs.is-fullwidth li{flex-grow:1;flex-shrink:0}.tabs.is-toggle a{border-color:#dbdbdb;border-style:solid;border-width:1px;margin-bottom:0;position:relative}.tabs.is-toggle a:hover{background-color:#f5f5f5;border-color:#b5b5b5;z-index:2}.tabs.is-toggle li+li{margin-left:-1px}.tabs.is-toggle li:first-child a{border-top-left-radius:4px;border-bottom-left-radius:4px}.tabs.is-toggle li:last-child a{border-top-right-radius:4px;border-bottom-right-radius:4px}.tabs.is-toggle li.is-active a{background-color:#485fc7;border-color:#485fc7;color:#fff;z-index:1}.tabs.is-toggle ul{border-bottom:none}.tabs.is-toggle.is-toggle-rounded li:first-child a{border-bottom-left-radius:9999px;border-top-left-radius:9999px;padding-left:1.25em}.tabs.is-toggle.is-toggle-rounded li:last-child a{border-bottom-right-radius:9999px;border-top-right-radius:9999px;padding-right:1.25em}.tabs.is-small{font-size:.75rem}.tabs.is-medium{font-size:1.25rem}.tabs.is-large{font-size:1.5rem}.column{display:block;flex-basis:0;flex-grow:1;flex-shrink:1;padding:.75rem}.columns.is-mobile>.column.is-narrow{flex:none;width:unset}.columns.is-mobile>.column.is-full{flex:none;width:100%}.columns.is-mobile>.column.is-three-quarters{flex:none;width:75%}.columns.is-mobile>.column.is-two-thirds{flex:none;width:66.6666%}.columns.is-mobile>.column.is-half{flex:none;width:50%}.columns.is-mobile>.column.is-one-third{flex:none;width:33.3333%}.columns.is-mobile>.column.is-one-quarter{flex:none;width:25%}.columns.is-mobile>.column.is-one-fifth{flex:none;width:20%}.columns.is-mobile>.column.is-two-fifths{flex:none;width:40%}.columns.is-mobile>.column.is-three-fifths{flex:none;width:60%}.columns.is-mobile>.column.is-four-fifths{flex:none;width:80%}.columns.is-mobile>.column.is-offset-three-quarters{margin-left:75%}.columns.is-mobile>.column.is-offset-two-thirds{margin-left:66.6666%}.columns.is-mobile>.column.is-offset-half{margin-left:50%}.columns.is-mobile>.column.is-offset-one-third{margin-left:33.3333%}.columns.is-mobile>.column.is-offset-one-quarter{margin-left:25%}.columns.is-mobile>.column.is-offset-one-fifth{margin-left:20%}.columns.is-mobile>.column.is-offset-two-fifths{margin-left:40%}.columns.is-mobile>.column.is-offset-three-fifths{margin-left:60%}.columns.is-mobile>.column.is-offset-four-fifths{margin-left:80%}.columns.is-mobile>.column.is-0{flex:none;width:0%}.columns.is-mobile>.column.is-offset-0{margin-left:0}.columns.is-mobile>.column.is-1{flex:none;width:8.33333%}.columns.is-mobile>.column.is-offset-1{margin-left:8.33333%}.columns.is-mobile>.column.is-2{flex:none;width:16.66667%}.columns.is-mobile>.column.is-offset-2{margin-left:16.66667%}.columns.is-mobile>.column.is-3{flex:none;width:25%}.columns.is-mobile>.column.is-offset-3{margin-left:25%}.columns.is-mobile>.column.is-4{flex:none;width:33.33333%}.columns.is-mobile>.column.is-offset-4{margin-left:33.33333%}.columns.is-mobile>.column.is-5{flex:none;width:41.66667%}.columns.is-mobile>.column.is-offset-5{margin-left:41.66667%}.columns.is-mobile>.column.is-6{flex:none;width:50%}.columns.is-mobile>.column.is-offset-6{margin-left:50%}.columns.is-mobile>.column.is-7{flex:none;width:58.33333%}.columns.is-mobile>.column.is-offset-7{margin-left:58.33333%}.columns.is-mobile>.column.is-8{flex:none;width:66.66667%}.columns.is-mobile>.column.is-offset-8{margin-left:66.66667%}.columns.is-mobile>.column.is-9{flex:none;width:75%}.columns.is-mobile>.column.is-offset-9{margin-left:75%}.columns.is-mobile>.column.is-10{flex:none;width:83.33333%}.columns.is-mobile>.column.is-offset-10{margin-left:83.33333%}.columns.is-mobile>.column.is-11{flex:none;width:91.66667%}.columns.is-mobile>.column.is-offset-11{margin-left:91.66667%}.columns.is-mobile>.column.is-12{flex:none;width:100%}.columns.is-mobile>.column.is-offset-12{margin-left:100%}@media screen and (max-width:768px){.column.is-narrow-mobile{flex:none;width:unset}.column.is-full-mobile{flex:none;width:100%}.column.is-three-quarters-mobile{flex:none;width:75%}.column.is-two-thirds-mobile{flex:none;width:66.6666%}.column.is-half-mobile{flex:none;width:50%}.column.is-one-third-mobile{flex:none;width:33.3333%}.column.is-one-quarter-mobile{flex:none;width:25%}.column.is-one-fifth-mobile{flex:none;width:20%}.column.is-two-fifths-mobile{flex:none;width:40%}.column.is-three-fifths-mobile{flex:none;width:60%}.column.is-four-fifths-mobile{flex:none;width:80%}.column.is-offset-three-quarters-mobile{margin-left:75%}.column.is-offset-two-thirds-mobile{margin-left:66.6666%}.column.is-offset-half-mobile{margin-left:50%}.column.is-offset-one-third-mobile{margin-left:33.3333%}.column.is-offset-one-quarter-mobile{margin-left:25%}.column.is-offset-one-fifth-mobile{margin-left:20%}.column.is-offset-two-fifths-mobile{margin-left:40%}.column.is-offset-three-fifths-mobile{margin-left:60%}.column.is-offset-four-fifths-mobile{margin-left:80%}.column.is-0-mobile{flex:none;width:0%}.column.is-offset-0-mobile{margin-left:0}.column.is-1-mobile{flex:none;width:8.33333%}.column.is-offset-1-mobile{margin-left:8.33333%}.column.is-2-mobile{flex:none;width:16.66667%}.column.is-offset-2-mobile{margin-left:16.66667%}.column.is-3-mobile{flex:none;width:25%}.column.is-offset-3-mobile{margin-left:25%}.column.is-4-mobile{flex:none;width:33.33333%}.column.is-offset-4-mobile{margin-left:33.33333%}.column.is-5-mobile{flex:none;width:41.66667%}.column.is-offset-5-mobile{margin-left:41.66667%}.column.is-6-mobile{flex:none;width:50%}.column.is-offset-6-mobile{margin-left:50%}.column.is-7-mobile{flex:none;width:58.33333%}.column.is-offset-7-mobile{margin-left:58.33333%}.column.is-8-mobile{flex:none;width:66.66667%}.column.is-offset-8-mobile{margin-left:66.66667%}.column.is-9-mobile{flex:none;width:75%}.column.is-offset-9-mobile{margin-left:75%}.column.is-10-mobile{flex:none;width:83.33333%}.column.is-offset-10-mobile{margin-left:83.33333%}.column.is-11-mobile{flex:none;width:91.66667%}.column.is-offset-11-mobile{margin-left:91.66667%}.column.is-12-mobile{flex:none;width:100%}.column.is-offset-12-mobile{margin-left:100%}}@media screen and (min-width:769px),print{.column.is-narrow,.column.is-narrow-tablet{flex:none;width:unset}.column.is-full,.column.is-full-tablet{flex:none;width:100%}.column.is-three-quarters,.column.is-three-quarters-tablet{flex:none;width:75%}.column.is-two-thirds,.column.is-two-thirds-tablet{flex:none;width:66.6666%}.column.is-half,.column.is-half-tablet{flex:none;width:50%}.column.is-one-third,.column.is-one-third-tablet{flex:none;width:33.3333%}.column.is-one-quarter,.column.is-one-quarter-tablet{flex:none;width:25%}.column.is-one-fifth,.column.is-one-fifth-tablet{flex:none;width:20%}.column.is-two-fifths,.column.is-two-fifths-tablet{flex:none;width:40%}.column.is-three-fifths,.column.is-three-fifths-tablet{flex:none;width:60%}.column.is-four-fifths,.column.is-four-fifths-tablet{flex:none;width:80%}.column.is-offset-three-quarters,.column.is-offset-three-quarters-tablet{margin-left:75%}.column.is-offset-two-thirds,.column.is-offset-two-thirds-tablet{margin-left:66.6666%}.column.is-offset-half,.column.is-offset-half-tablet{margin-left:50%}.column.is-offset-one-third,.column.is-offset-one-third-tablet{margin-left:33.3333%}.column.is-offset-one-quarter,.column.is-offset-one-quarter-tablet{margin-left:25%}.column.is-offset-one-fifth,.column.is-offset-one-fifth-tablet{margin-left:20%}.column.is-offset-two-fifths,.column.is-offset-two-fifths-tablet{margin-left:40%}.column.is-offset-three-fifths,.column.is-offset-three-fifths-tablet{margin-left:60%}.column.is-offset-four-fifths,.column.is-offset-four-fifths-tablet{margin-left:80%}.column.is-0,.column.is-0-tablet{flex:none;width:0%}.column.is-offset-0,.column.is-offset-0-tablet{margin-left:0}.column.is-1,.column.is-1-tablet{flex:none;width:8.33333%}.column.is-offset-1,.column.is-offset-1-tablet{margin-left:8.33333%}.column.is-2,.column.is-2-tablet{flex:none;width:16.66667%}.column.is-offset-2,.column.is-offset-2-tablet{margin-left:16.66667%}.column.is-3,.column.is-3-tablet{flex:none;width:25%}.column.is-offset-3,.column.is-offset-3-tablet{margin-left:25%}.column.is-4,.column.is-4-tablet{flex:none;width:33.33333%}.column.is-offset-4,.column.is-offset-4-tablet{margin-left:33.33333%}.column.is-5,.column.is-5-tablet{flex:none;width:41.66667%}.column.is-offset-5,.column.is-offset-5-tablet{margin-left:41.66667%}.column.is-6,.column.is-6-tablet{flex:none;width:50%}.column.is-offset-6,.column.is-offset-6-tablet{margin-left:50%}.column.is-7,.column.is-7-tablet{flex:none;width:58.33333%}.column.is-offset-7,.column.is-offset-7-tablet{margin-left:58.33333%}.column.is-8,.column.is-8-tablet{flex:none;width:66.66667%}.column.is-offset-8,.column.is-offset-8-tablet{margin-left:66.66667%}.column.is-9,.column.is-9-tablet{flex:none;width:75%}.column.is-offset-9,.column.is-offset-9-tablet{margin-left:75%}.column.is-10,.column.is-10-tablet{flex:none;width:83.33333%}.column.is-offset-10,.column.is-offset-10-tablet{margin-left:83.33333%}.column.is-11,.column.is-11-tablet{flex:none;width:91.66667%}.column.is-offset-11,.column.is-offset-11-tablet{margin-left:91.66667%}.column.is-12,.column.is-12-tablet{flex:none;width:100%}.column.is-offset-12,.column.is-offset-12-tablet{margin-left:100%}}@media screen and (max-width:1023px){.column.is-narrow-touch{flex:none;width:unset}.column.is-full-touch{flex:none;width:100%}.column.is-three-quarters-touch{flex:none;width:75%}.column.is-two-thirds-touch{flex:none;width:66.6666%}.column.is-half-touch{flex:none;width:50%}.column.is-one-third-touch{flex:none;width:33.3333%}.column.is-one-quarter-touch{flex:none;width:25%}.column.is-one-fifth-touch{flex:none;width:20%}.column.is-two-fifths-touch{flex:none;width:40%}.column.is-three-fifths-touch{flex:none;width:60%}.column.is-four-fifths-touch{flex:none;width:80%}.column.is-offset-three-quarters-touch{margin-left:75%}.column.is-offset-two-thirds-touch{margin-left:66.6666%}.column.is-offset-half-touch{margin-left:50%}.column.is-offset-one-third-touch{margin-left:33.3333%}.column.is-offset-one-quarter-touch{margin-left:25%}.column.is-offset-one-fifth-touch{margin-left:20%}.column.is-offset-two-fifths-touch{margin-left:40%}.column.is-offset-three-fifths-touch{margin-left:60%}.column.is-offset-four-fifths-touch{margin-left:80%}.column.is-0-touch{flex:none;width:0%}.column.is-offset-0-touch{margin-left:0}.column.is-1-touch{flex:none;width:8.33333%}.column.is-offset-1-touch{margin-left:8.33333%}.column.is-2-touch{flex:none;width:16.66667%}.column.is-offset-2-touch{margin-left:16.66667%}.column.is-3-touch{flex:none;width:25%}.column.is-offset-3-touch{margin-left:25%}.column.is-4-touch{flex:none;width:33.33333%}.column.is-offset-4-touch{margin-left:33.33333%}.column.is-5-touch{flex:none;width:41.66667%}.column.is-offset-5-touch{margin-left:41.66667%}.column.is-6-touch{flex:none;width:50%}.column.is-offset-6-touch{margin-left:50%}.column.is-7-touch{flex:none;width:58.33333%}.column.is-offset-7-touch{margin-left:58.33333%}.column.is-8-touch{flex:none;width:66.66667%}.column.is-offset-8-touch{margin-left:66.66667%}.column.is-9-touch{flex:none;width:75%}.column.is-offset-9-touch{margin-left:75%}.column.is-10-touch{flex:none;width:83.33333%}.column.is-offset-10-touch{margin-left:83.33333%}.column.is-11-touch{flex:none;width:91.66667%}.column.is-offset-11-touch{margin-left:91.66667%}.column.is-12-touch{flex:none;width:100%}.column.is-offset-12-touch{margin-left:100%}}@media screen and (min-width:1024px){.column.is-narrow-desktop{flex:none;width:unset}.column.is-full-desktop{flex:none;width:100%}.column.is-three-quarters-desktop{flex:none;width:75%}.column.is-two-thirds-desktop{flex:none;width:66.6666%}.column.is-half-desktop{flex:none;width:50%}.column.is-one-third-desktop{flex:none;width:33.3333%}.column.is-one-quarter-desktop{flex:none;width:25%}.column.is-one-fifth-desktop{flex:none;width:20%}.column.is-two-fifths-desktop{flex:none;width:40%}.column.is-three-fifths-desktop{flex:none;width:60%}.column.is-four-fifths-desktop{flex:none;width:80%}.column.is-offset-three-quarters-desktop{margin-left:75%}.column.is-offset-two-thirds-desktop{margin-left:66.6666%}.column.is-offset-half-desktop{margin-left:50%}.column.is-offset-one-third-desktop{margin-left:33.3333%}.column.is-offset-one-quarter-desktop{margin-left:25%}.column.is-offset-one-fifth-desktop{margin-left:20%}.column.is-offset-two-fifths-desktop{margin-left:40%}.column.is-offset-three-fifths-desktop{margin-left:60%}.column.is-offset-four-fifths-desktop{margin-left:80%}.column.is-0-desktop{flex:none;width:0%}.column.is-offset-0-desktop{margin-left:0}.column.is-1-desktop{flex:none;width:8.33333%}.column.is-offset-1-desktop{margin-left:8.33333%}.column.is-2-desktop{flex:none;width:16.66667%}.column.is-offset-2-desktop{margin-left:16.66667%}.column.is-3-desktop{flex:none;width:25%}.column.is-offset-3-desktop{margin-left:25%}.column.is-4-desktop{flex:none;width:33.33333%}.column.is-offset-4-desktop{margin-left:33.33333%}.column.is-5-desktop{flex:none;width:41.66667%}.column.is-offset-5-desktop{margin-left:41.66667%}.column.is-6-desktop{flex:none;width:50%}.column.is-offset-6-desktop{margin-left:50%}.column.is-7-desktop{flex:none;width:58.33333%}.column.is-offset-7-desktop{margin-left:58.33333%}.column.is-8-desktop{flex:none;width:66.66667%}.column.is-offset-8-desktop{margin-left:66.66667%}.column.is-9-desktop{flex:none;width:75%}.column.is-offset-9-desktop{margin-left:75%}.column.is-10-desktop{flex:none;width:83.33333%}.column.is-offset-10-desktop{margin-left:83.33333%}.column.is-11-desktop{flex:none;width:91.66667%}.column.is-offset-11-desktop{margin-left:91.66667%}.column.is-12-desktop{flex:none;width:100%}.column.is-offset-12-desktop{margin-left:100%}}@media screen and (min-width:1216px){.column.is-narrow-widescreen{flex:none;width:unset}.column.is-full-widescreen{flex:none;width:100%}.column.is-three-quarters-widescreen{flex:none;width:75%}.column.is-two-thirds-widescreen{flex:none;width:66.6666%}.column.is-half-widescreen{flex:none;width:50%}.column.is-one-third-widescreen{flex:none;width:33.3333%}.column.is-one-quarter-widescreen{flex:none;width:25%}.column.is-one-fifth-widescreen{flex:none;width:20%}.column.is-two-fifths-widescreen{flex:none;width:40%}.column.is-three-fifths-widescreen{flex:none;width:60%}.column.is-four-fifths-widescreen{flex:none;width:80%}.column.is-offset-three-quarters-widescreen{margin-left:75%}.column.is-offset-two-thirds-widescreen{margin-left:66.6666%}.column.is-offset-half-widescreen{margin-left:50%}.column.is-offset-one-third-widescreen{margin-left:33.3333%}.column.is-offset-one-quarter-widescreen{margin-left:25%}.column.is-offset-one-fifth-widescreen{margin-left:20%}.column.is-offset-two-fifths-widescreen{margin-left:40%}.column.is-offset-three-fifths-widescreen{margin-left:60%}.column.is-offset-four-fifths-widescreen{margin-left:80%}.column.is-0-widescreen{flex:none;width:0%}.column.is-offset-0-widescreen{margin-left:0}.column.is-1-widescreen{flex:none;width:8.33333%}.column.is-offset-1-widescreen{margin-left:8.33333%}.column.is-2-widescreen{flex:none;width:16.66667%}.column.is-offset-2-widescreen{margin-left:16.66667%}.column.is-3-widescreen{flex:none;width:25%}.column.is-offset-3-widescreen{margin-left:25%}.column.is-4-widescreen{flex:none;width:33.33333%}.column.is-offset-4-widescreen{margin-left:33.33333%}.column.is-5-widescreen{flex:none;width:41.66667%}.column.is-offset-5-widescreen{margin-left:41.66667%}.column.is-6-widescreen{flex:none;width:50%}.column.is-offset-6-widescreen{margin-left:50%}.column.is-7-widescreen{flex:none;width:58.33333%}.column.is-offset-7-widescreen{margin-left:58.33333%}.column.is-8-widescreen{flex:none;width:66.66667%}.column.is-offset-8-widescreen{margin-left:66.66667%}.column.is-9-widescreen{flex:none;width:75%}.column.is-offset-9-widescreen{margin-left:75%}.column.is-10-widescreen{flex:none;width:83.33333%}.column.is-offset-10-widescreen{margin-left:83.33333%}.column.is-11-widescreen{flex:none;width:91.66667%}.column.is-offset-11-widescreen{margin-left:91.66667%}.column.is-12-widescreen{flex:none;width:100%}.column.is-offset-12-widescreen{margin-left:100%}}@media screen and (min-width:1408px){.column.is-narrow-fullhd{flex:none;width:unset}.column.is-full-fullhd{flex:none;width:100%}.column.is-three-quarters-fullhd{flex:none;width:75%}.column.is-two-thirds-fullhd{flex:none;width:66.6666%}.column.is-half-fullhd{flex:none;width:50%}.column.is-one-third-fullhd{flex:none;width:33.3333%}.column.is-one-quarter-fullhd{flex:none;width:25%}.column.is-one-fifth-fullhd{flex:none;width:20%}.column.is-two-fifths-fullhd{flex:none;width:40%}.column.is-three-fifths-fullhd{flex:none;width:60%}.column.is-four-fifths-fullhd{flex:none;width:80%}.column.is-offset-three-quarters-fullhd{margin-left:75%}.column.is-offset-two-thirds-fullhd{margin-left:66.6666%}.column.is-offset-half-fullhd{margin-left:50%}.column.is-offset-one-third-fullhd{margin-left:33.3333%}.column.is-offset-one-quarter-fullhd{margin-left:25%}.column.is-offset-one-fifth-fullhd{margin-left:20%}.column.is-offset-two-fifths-fullhd{margin-left:40%}.column.is-offset-three-fifths-fullhd{margin-left:60%}.column.is-offset-four-fifths-fullhd{margin-left:80%}.column.is-0-fullhd{flex:none;width:0%}.column.is-offset-0-fullhd{margin-left:0}.column.is-1-fullhd{flex:none;width:8.33333%}.column.is-offset-1-fullhd{margin-left:8.33333%}.column.is-2-fullhd{flex:none;width:16.66667%}.column.is-offset-2-fullhd{margin-left:16.66667%}.column.is-3-fullhd{flex:none;width:25%}.column.is-offset-3-fullhd{margin-left:25%}.column.is-4-fullhd{flex:none;width:33.33333%}.column.is-offset-4-fullhd{margin-left:33.33333%}.column.is-5-fullhd{flex:none;width:41.66667%}.column.is-offset-5-fullhd{margin-left:41.66667%}.column.is-6-fullhd{flex:none;width:50%}.column.is-offset-6-fullhd{margin-left:50%}.column.is-7-fullhd{flex:none;width:58.33333%}.column.is-offset-7-fullhd{margin-left:58.33333%}.column.is-8-fullhd{flex:none;width:66.66667%}.column.is-offset-8-fullhd{margin-left:66.66667%}.column.is-9-fullhd{flex:none;width:75%}.column.is-offset-9-fullhd{margin-left:75%}.column.is-10-fullhd{flex:none;width:83.33333%}.column.is-offset-10-fullhd{margin-left:83.33333%}.column.is-11-fullhd{flex:none;width:91.66667%}.column.is-offset-11-fullhd{margin-left:91.66667%}.column.is-12-fullhd{flex:none;width:100%}.column.is-offset-12-fullhd{margin-left:100%}}.columns{margin-left:-.75rem;margin-right:-.75rem;margin-top:-.75rem}.columns:last-child{margin-bottom:-.75rem}.columns:not(:last-child){margin-bottom:calc(1.5rem - .75rem)}.columns.is-centered{justify-content:center}.columns.is-gapless{margin-left:0;margin-right:0;margin-top:0}.columns.is-gapless>.column{margin:0;padding:0!important}.columns.is-gapless:not(:last-child){margin-bottom:1.5rem}.columns.is-gapless:last-child{margin-bottom:0}.columns.is-mobile{display:flex}.columns.is-multiline{flex-wrap:wrap}.columns.is-vcentered{align-items:center}@media screen and (min-width:769px),print{.columns:not(.is-desktop){display:flex}}@media screen and (min-width:1024px){.columns.is-desktop{display:flex}}.columns.is-variable{--columnGap:0.75rem;margin-left:calc(-1 * var(--columnGap));margin-right:calc(-1 * var(--columnGap))}.columns.is-variable>.column{padding-left:var(--columnGap);padding-right:var(--columnGap)}.columns.is-variable.is-0{--columnGap:0rem}@media screen and (max-width:768px){.columns.is-variable.is-0-mobile{--columnGap:0rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-0-tablet{--columnGap:0rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-0-tablet-only{--columnGap:0rem}}@media screen and (max-width:1023px){.columns.is-variable.is-0-touch{--columnGap:0rem}}@media screen and (min-width:1024px){.columns.is-variable.is-0-desktop{--columnGap:0rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-0-desktop-only{--columnGap:0rem}}@media screen and (min-width:1216px){.columns.is-variable.is-0-widescreen{--columnGap:0rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-0-widescreen-only{--columnGap:0rem}}@media screen and (min-width:1408px){.columns.is-variable.is-0-fullhd{--columnGap:0rem}}.columns.is-variable.is-1{--columnGap:0.25rem}@media screen and (max-width:768px){.columns.is-variable.is-1-mobile{--columnGap:0.25rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-1-tablet{--columnGap:0.25rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-1-tablet-only{--columnGap:0.25rem}}@media screen and (max-width:1023px){.columns.is-variable.is-1-touch{--columnGap:0.25rem}}@media screen and (min-width:1024px){.columns.is-variable.is-1-desktop{--columnGap:0.25rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-1-desktop-only{--columnGap:0.25rem}}@media screen and (min-width:1216px){.columns.is-variable.is-1-widescreen{--columnGap:0.25rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-1-widescreen-only{--columnGap:0.25rem}}@media screen and (min-width:1408px){.columns.is-variable.is-1-fullhd{--columnGap:0.25rem}}.columns.is-variable.is-2{--columnGap:0.5rem}@media screen and (max-width:768px){.columns.is-variable.is-2-mobile{--columnGap:0.5rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-2-tablet{--columnGap:0.5rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-2-tablet-only{--columnGap:0.5rem}}@media screen and (max-width:1023px){.columns.is-variable.is-2-touch{--columnGap:0.5rem}}@media screen and (min-width:1024px){.columns.is-variable.is-2-desktop{--columnGap:0.5rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-2-desktop-only{--columnGap:0.5rem}}@media screen and (min-width:1216px){.columns.is-variable.is-2-widescreen{--columnGap:0.5rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-2-widescreen-only{--columnGap:0.5rem}}@media screen and (min-width:1408px){.columns.is-variable.is-2-fullhd{--columnGap:0.5rem}}.columns.is-variable.is-3{--columnGap:0.75rem}@media screen and (max-width:768px){.columns.is-variable.is-3-mobile{--columnGap:0.75rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-3-tablet{--columnGap:0.75rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-3-tablet-only{--columnGap:0.75rem}}@media screen and (max-width:1023px){.columns.is-variable.is-3-touch{--columnGap:0.75rem}}@media screen and (min-width:1024px){.columns.is-variable.is-3-desktop{--columnGap:0.75rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-3-desktop-only{--columnGap:0.75rem}}@media screen and (min-width:1216px){.columns.is-variable.is-3-widescreen{--columnGap:0.75rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-3-widescreen-only{--columnGap:0.75rem}}@media screen and (min-width:1408px){.columns.is-variable.is-3-fullhd{--columnGap:0.75rem}}.columns.is-variable.is-4{--columnGap:1rem}@media screen and (max-width:768px){.columns.is-variable.is-4-mobile{--columnGap:1rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-4-tablet{--columnGap:1rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-4-tablet-only{--columnGap:1rem}}@media screen and (max-width:1023px){.columns.is-variable.is-4-touch{--columnGap:1rem}}@media screen and (min-width:1024px){.columns.is-variable.is-4-desktop{--columnGap:1rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-4-desktop-only{--columnGap:1rem}}@media screen and (min-width:1216px){.columns.is-variable.is-4-widescreen{--columnGap:1rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-4-widescreen-only{--columnGap:1rem}}@media screen and (min-width:1408px){.columns.is-variable.is-4-fullhd{--columnGap:1rem}}.columns.is-variable.is-5{--columnGap:1.25rem}@media screen and (max-width:768px){.columns.is-variable.is-5-mobile{--columnGap:1.25rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-5-tablet{--columnGap:1.25rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-5-tablet-only{--columnGap:1.25rem}}@media screen and (max-width:1023px){.columns.is-variable.is-5-touch{--columnGap:1.25rem}}@media screen and (min-width:1024px){.columns.is-variable.is-5-desktop{--columnGap:1.25rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-5-desktop-only{--columnGap:1.25rem}}@media screen and (min-width:1216px){.columns.is-variable.is-5-widescreen{--columnGap:1.25rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-5-widescreen-only{--columnGap:1.25rem}}@media screen and (min-width:1408px){.columns.is-variable.is-5-fullhd{--columnGap:1.25rem}}.columns.is-variable.is-6{--columnGap:1.5rem}@media screen and (max-width:768px){.columns.is-variable.is-6-mobile{--columnGap:1.5rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-6-tablet{--columnGap:1.5rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-6-tablet-only{--columnGap:1.5rem}}@media screen and (max-width:1023px){.columns.is-variable.is-6-touch{--columnGap:1.5rem}}@media screen and (min-width:1024px){.columns.is-variable.is-6-desktop{--columnGap:1.5rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-6-desktop-only{--columnGap:1.5rem}}@media screen and (min-width:1216px){.columns.is-variable.is-6-widescreen{--columnGap:1.5rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-6-widescreen-only{--columnGap:1.5rem}}@media screen and (min-width:1408px){.columns.is-variable.is-6-fullhd{--columnGap:1.5rem}}.columns.is-variable.is-7{--columnGap:1.75rem}@media screen and (max-width:768px){.columns.is-variable.is-7-mobile{--columnGap:1.75rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-7-tablet{--columnGap:1.75rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-7-tablet-only{--columnGap:1.75rem}}@media screen and (max-width:1023px){.columns.is-variable.is-7-touch{--columnGap:1.75rem}}@media screen and (min-width:1024px){.columns.is-variable.is-7-desktop{--columnGap:1.75rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-7-desktop-only{--columnGap:1.75rem}}@media screen and (min-width:1216px){.columns.is-variable.is-7-widescreen{--columnGap:1.75rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-7-widescreen-only{--columnGap:1.75rem}}@media screen and (min-width:1408px){.columns.is-variable.is-7-fullhd{--columnGap:1.75rem}}.columns.is-variable.is-8{--columnGap:2rem}@media screen and (max-width:768px){.columns.is-variable.is-8-mobile{--columnGap:2rem}}@media screen and (min-width:769px),print{.columns.is-variable.is-8-tablet{--columnGap:2rem}}@media screen and (min-width:769px) and (max-width:1023px){.columns.is-variable.is-8-tablet-only{--columnGap:2rem}}@media screen and (max-width:1023px){.columns.is-variable.is-8-touch{--columnGap:2rem}}@media screen and (min-width:1024px){.columns.is-variable.is-8-desktop{--columnGap:2rem}}@media screen and (min-width:1024px) and (max-width:1215px){.columns.is-variable.is-8-desktop-only{--columnGap:2rem}}@media screen and (min-width:1216px){.columns.is-variable.is-8-widescreen{--columnGap:2rem}}@media screen and (min-width:1216px) and (max-width:1407px){.columns.is-variable.is-8-widescreen-only{--columnGap:2rem}}@media screen and (min-width:1408px){.columns.is-variable.is-8-fullhd{--columnGap:2rem}}.tile{align-items:stretch;display:block;flex-basis:0;flex-grow:1;flex-shrink:1;min-height:-webkit-min-content;min-height:-moz-min-content;min-height:min-content}.tile.is-ancestor{margin-left:-.75rem;margin-right:-.75rem;margin-top:-.75rem}.tile.is-ancestor:last-child{margin-bottom:-.75rem}.tile.is-ancestor:not(:last-child){margin-bottom:.75rem}.tile.is-child{margin:0!important}.tile.is-parent{padding:.75rem}.tile.is-vertical{flex-direction:column}.tile.is-vertical>.tile.is-child:not(:last-child){margin-bottom:1.5rem!important}@media screen and (min-width:769px),print{.tile:not(.is-child){display:flex}.tile.is-1{flex:none;width:8.33333%}.tile.is-2{flex:none;width:16.66667%}.tile.is-3{flex:none;width:25%}.tile.is-4{flex:none;width:33.33333%}.tile.is-5{flex:none;width:41.66667%}.tile.is-6{flex:none;width:50%}.tile.is-7{flex:none;width:58.33333%}.tile.is-8{flex:none;width:66.66667%}.tile.is-9{flex:none;width:75%}.tile.is-10{flex:none;width:83.33333%}.tile.is-11{flex:none;width:91.66667%}.tile.is-12{flex:none;width:100%}}.has-text-white{color:#fff!important}a.has-text-white:focus,a.has-text-white:hover{color:#e6e6e6!important}.has-background-white{background-color:#fff!important}.has-text-black{color:#0a0a0a!important}a.has-text-black:focus,a.has-text-black:hover{color:#000!important}.has-background-black{background-color:#0a0a0a!important}.has-text-light{color:#f5f5f5!important}a.has-text-light:focus,a.has-text-light:hover{color:#dbdbdb!important}.has-background-light{background-color:#f5f5f5!important}.has-text-dark{color:#363636!important}a.has-text-dark:focus,a.has-text-dark:hover{color:#1c1c1c!important}.has-background-dark{background-color:#363636!important}.has-text-primary{color:#00d1b2!important}a.has-text-primary:focus,a.has-text-primary:hover{color:#009e86!important}.has-background-primary{background-color:#00d1b2!important}.has-text-primary-light{color:#ebfffc!important}a.has-text-primary-light:focus,a.has-text-primary-light:hover{color:#b8fff4!important}.has-background-primary-light{background-color:#ebfffc!important}.has-text-primary-dark{color:#00947e!important}a.has-text-primary-dark:focus,a.has-text-primary-dark:hover{color:#00c7a9!important}.has-background-primary-dark{background-color:#00947e!important}.has-text-link{color:#485fc7!important}a.has-text-link:focus,a.has-text-link:hover{color:#3449a8!important}.has-background-link{background-color:#485fc7!important}.has-text-link-light{color:#eff1fa!important}a.has-text-link-light:focus,a.has-text-link-light:hover{color:#c8cfee!important}.has-background-link-light{background-color:#eff1fa!important}.has-text-link-dark{color:#3850b7!important}a.has-text-link-dark:focus,a.has-text-link-dark:hover{color:#576dcb!important}.has-background-link-dark{background-color:#3850b7!important}.has-text-info{color:#3e8ed0!important}a.has-text-info:focus,a.has-text-info:hover{color:#2b74b1!important}.has-background-info{background-color:#3e8ed0!important}.has-text-info-light{color:#eff5fb!important}a.has-text-info-light:focus,a.has-text-info-light:hover{color:#c6ddf1!important}.has-background-info-light{background-color:#eff5fb!important}.has-text-info-dark{color:#296fa8!important}a.has-text-info-dark:focus,a.has-text-info-dark:hover{color:#368ace!important}.has-background-info-dark{background-color:#296fa8!important}.has-text-success{color:#48c78e!important}a.has-text-success:focus,a.has-text-success:hover{color:#34a873!important}.has-background-success{background-color:#48c78e!important}.has-text-success-light{color:#effaf5!important}a.has-text-success-light:focus,a.has-text-success-light:hover{color:#c8eedd!important}.has-background-success-light{background-color:#effaf5!important}.has-text-success-dark{color:#257953!important}a.has-text-success-dark:focus,a.has-text-success-dark:hover{color:#31a06e!important}.has-background-success-dark{background-color:#257953!important}.has-text-warning{color:#ffe08a!important}a.has-text-warning:focus,a.has-text-warning:hover{color:#ffd257!important}.has-background-warning{background-color:#ffe08a!important}.has-text-warning-light{color:#fffaeb!important}a.has-text-warning-light:focus,a.has-text-warning-light:hover{color:#ffecb8!important}.has-background-warning-light{background-color:#fffaeb!important}.has-text-warning-dark{color:#946c00!important}a.has-text-warning-dark:focus,a.has-text-warning-dark:hover{color:#c79200!important}.has-background-warning-dark{background-color:#946c00!important}.has-text-danger{color:#f14668!important}a.has-text-danger:focus,a.has-text-danger:hover{color:#ee1742!important}.has-background-danger{background-color:#f14668!important}.has-text-danger-light{color:#feecf0!important}a.has-text-danger-light:focus,a.has-text-danger-light:hover{color:#fabdc9!important}.has-background-danger-light{background-color:#feecf0!important}.has-text-danger-dark{color:#cc0f35!important}a.has-text-danger-dark:focus,a.has-text-danger-dark:hover{color:#ee2049!important}.has-background-danger-dark{background-color:#cc0f35!important}.has-text-black-bis{color:#121212!important}.has-background-black-bis{background-color:#121212!important}.has-text-black-ter{color:#242424!important}.has-background-black-ter{background-color:#242424!important}.has-text-grey-darker{color:#363636!important}.has-background-grey-darker{background-color:#363636!important}.has-text-grey-dark{color:#4a4a4a!important}.has-background-grey-dark{background-color:#4a4a4a!important}.has-text-grey{color:#7a7a7a!important}.has-background-grey{background-color:#7a7a7a!important}.has-text-grey-light{color:#b5b5b5!important}.has-background-grey-light{background-color:#b5b5b5!important}.has-text-grey-lighter{color:#dbdbdb!important}.has-background-grey-lighter{background-color:#dbdbdb!important}.has-text-white-ter{color:#f5f5f5!important}.has-background-white-ter{background-color:#f5f5f5!important}.has-text-white-bis{color:#fafafa!important}.has-background-white-bis{background-color:#fafafa!important}.is-flex-direction-row{flex-direction:row!important}.is-flex-direction-row-reverse{flex-direction:row-reverse!important}.is-flex-direction-column{flex-direction:column!important}.is-flex-direction-column-reverse{flex-direction:column-reverse!important}.is-flex-wrap-nowrap{flex-wrap:nowrap!important}.is-flex-wrap-wrap{flex-wrap:wrap!important}.is-flex-wrap-wrap-reverse{flex-wrap:wrap-reverse!important}.is-justify-content-flex-start{justify-content:flex-start!important}.is-justify-content-flex-end{justify-content:flex-end!important}.is-justify-content-center{justify-content:center!important}.is-justify-content-space-between{justify-content:space-between!important}.is-justify-content-space-around{justify-content:space-around!important}.is-justify-content-space-evenly{justify-content:space-evenly!important}.is-justify-content-start{justify-content:start!important}.is-justify-content-end{justify-content:end!important}.is-justify-content-left{justify-content:left!important}.is-justify-content-right{justify-content:right!important}.is-align-content-flex-start{align-content:flex-start!important}.is-align-content-flex-end{align-content:flex-end!important}.is-align-content-center{align-content:center!important}.is-align-content-space-between{align-content:space-between!important}.is-align-content-space-around{align-content:space-around!important}.is-align-content-space-evenly{align-content:space-evenly!important}.is-align-content-stretch{align-content:stretch!important}.is-align-content-start{align-content:start!important}.is-align-content-end{align-content:end!important}.is-align-content-baseline{align-content:baseline!important}.is-align-items-stretch{align-items:stretch!important}.is-align-items-flex-start{align-items:flex-start!important}.is-align-items-flex-end{align-items:flex-end!important}.is-align-items-center{align-items:center!important}.is-align-items-baseline{align-items:baseline!important}.is-align-items-start{align-items:start!important}.is-align-items-end{align-items:end!important}.is-align-items-self-start{align-items:self-start!important}.is-align-items-self-end{align-items:self-end!important}.is-align-self-auto{align-self:auto!important}.is-align-self-flex-start{align-self:flex-start!important}.is-align-self-flex-end{align-self:flex-end!important}.is-align-self-center{align-self:center!important}.is-align-self-baseline{align-self:baseline!important}.is-align-self-stretch{align-self:stretch!important}.is-flex-grow-0{flex-grow:0!important}.is-flex-grow-1{flex-grow:1!important}.is-flex-grow-2{flex-grow:2!important}.is-flex-grow-3{flex-grow:3!important}.is-flex-grow-4{flex-grow:4!important}.is-flex-grow-5{flex-grow:5!important}.is-flex-shrink-0{flex-shrink:0!important}.is-flex-shrink-1{flex-shrink:1!important}.is-flex-shrink-2{flex-shrink:2!important}.is-flex-shrink-3{flex-shrink:3!important}.is-flex-shrink-4{flex-shrink:4!important}.is-flex-shrink-5{flex-shrink:5!important}.is-clearfix::after{clear:both;content:\" \";display:table}.is-pulled-left{float:left!important}.is-pulled-right{float:right!important}.is-radiusless{border-radius:0!important}.is-shadowless{box-shadow:none!important}.is-clickable{cursor:pointer!important;pointer-events:all!important}.is-clipped{overflow:hidden!important}.is-relative{position:relative!important}.is-marginless{margin:0!important}.is-paddingless{padding:0!important}.m-0{margin:0!important}.mt-0{margin-top:0!important}.mr-0{margin-right:0!important}.mb-0{margin-bottom:0!important}.ml-0{margin-left:0!important}.mx-0{margin-left:0!important;margin-right:0!important}.my-0{margin-top:0!important;margin-bottom:0!important}.m-1{margin:.25rem!important}.mt-1{margin-top:.25rem!important}.mr-1{margin-right:.25rem!important}.mb-1{margin-bottom:.25rem!important}.ml-1{margin-left:.25rem!important}.mx-1{margin-left:.25rem!important;margin-right:.25rem!important}.my-1{margin-top:.25rem!important;margin-bottom:.25rem!important}.m-2{margin:.5rem!important}.mt-2{margin-top:.5rem!important}.mr-2{margin-right:.5rem!important}.mb-2{margin-bottom:.5rem!important}.ml-2{margin-left:.5rem!important}.mx-2{margin-left:.5rem!important;margin-right:.5rem!important}.my-2{margin-top:.5rem!important;margin-bottom:.5rem!important}.m-3{margin:.75rem!important}.mt-3{margin-top:.75rem!important}.mr-3{margin-right:.75rem!important}.mb-3{margin-bottom:.75rem!important}.ml-3{margin-left:.75rem!important}.mx-3{margin-left:.75rem!important;margin-right:.75rem!important}.my-3{margin-top:.75rem!important;margin-bottom:.75rem!important}.m-4{margin:1rem!important}.mt-4{margin-top:1rem!important}.mr-4{margin-right:1rem!important}.mb-4{margin-bottom:1rem!important}.ml-4{margin-left:1rem!important}.mx-4{margin-left:1rem!important;margin-right:1rem!important}.my-4{margin-top:1rem!important;margin-bottom:1rem!important}.m-5{margin:1.5rem!important}.mt-5{margin-top:1.5rem!important}.mr-5{margin-right:1.5rem!important}.mb-5{margin-bottom:1.5rem!important}.ml-5{margin-left:1.5rem!important}.mx-5{margin-left:1.5rem!important;margin-right:1.5rem!important}.my-5{margin-top:1.5rem!important;margin-bottom:1.5rem!important}.m-6{margin:3rem!important}.mt-6{margin-top:3rem!important}.mr-6{margin-right:3rem!important}.mb-6{margin-bottom:3rem!important}.ml-6{margin-left:3rem!important}.mx-6{margin-left:3rem!important;margin-right:3rem!important}.my-6{margin-top:3rem!important;margin-bottom:3rem!important}.m-auto{margin:auto!important}.mt-auto{margin-top:auto!important}.mr-auto{margin-right:auto!important}.mb-auto{margin-bottom:auto!important}.ml-auto{margin-left:auto!important}.mx-auto{margin-left:auto!important;margin-right:auto!important}.my-auto{margin-top:auto!important;margin-bottom:auto!important}.p-0{padding:0!important}.pt-0{padding-top:0!important}.pr-0{padding-right:0!important}.pb-0{padding-bottom:0!important}.pl-0{padding-left:0!important}.px-0{padding-left:0!important;padding-right:0!important}.py-0{padding-top:0!important;padding-bottom:0!important}.p-1{padding:.25rem!important}.pt-1{padding-top:.25rem!important}.pr-1{padding-right:.25rem!important}.pb-1{padding-bottom:.25rem!important}.pl-1{padding-left:.25rem!important}.px-1{padding-left:.25rem!important;padding-right:.25rem!important}.py-1{padding-top:.25rem!important;padding-bottom:.25rem!important}.p-2{padding:.5rem!important}.pt-2{padding-top:.5rem!important}.pr-2{padding-right:.5rem!important}.pb-2{padding-bottom:.5rem!important}.pl-2{padding-left:.5rem!important}.px-2{padding-left:.5rem!important;padding-right:.5rem!important}.py-2{padding-top:.5rem!important;padding-bottom:.5rem!important}.p-3{padding:.75rem!important}.pt-3{padding-top:.75rem!important}.pr-3{padding-right:.75rem!important}.pb-3{padding-bottom:.75rem!important}.pl-3{padding-left:.75rem!important}.px-3{padding-left:.75rem!important;padding-right:.75rem!important}.py-3{padding-top:.75rem!important;padding-bottom:.75rem!important}.p-4{padding:1rem!important}.pt-4{padding-top:1rem!important}.pr-4{padding-right:1rem!important}.pb-4{padding-bottom:1rem!important}.pl-4{padding-left:1rem!important}.px-4{padding-left:1rem!important;padding-right:1rem!important}.py-4{padding-top:1rem!important;padding-bottom:1rem!important}.p-5{padding:1.5rem!important}.pt-5{padding-top:1.5rem!important}.pr-5{padding-right:1.5rem!important}.pb-5{padding-bottom:1.5rem!important}.pl-5{padding-left:1.5rem!important}.px-5{padding-left:1.5rem!important;padding-right:1.5rem!important}.py-5{padding-top:1.5rem!important;padding-bottom:1.5rem!important}.p-6{padding:3rem!important}.pt-6{padding-top:3rem!important}.pr-6{padding-right:3rem!important}.pb-6{padding-bottom:3rem!important}.pl-6{padding-left:3rem!important}.px-6{padding-left:3rem!important;padding-right:3rem!important}.py-6{padding-top:3rem!important;padding-bottom:3rem!important}.p-auto{padding:auto!important}.pt-auto{padding-top:auto!important}.pr-auto{padding-right:auto!important}.pb-auto{padding-bottom:auto!important}.pl-auto{padding-left:auto!important}.px-auto{padding-left:auto!important;padding-right:auto!important}.py-auto{padding-top:auto!important;padding-bottom:auto!important}.is-size-1{font-size:3rem!important}.is-size-2{font-size:2.5rem!important}.is-size-3{font-size:2rem!important}.is-size-4{font-size:1.5rem!important}.is-size-5{font-size:1.25rem!important}.is-size-6{font-size:1rem!important}.is-size-7{font-size:.75rem!important}@media screen and (max-width:768px){.is-size-1-mobile{font-size:3rem!important}.is-size-2-mobile{font-size:2.5rem!important}.is-size-3-mobile{font-size:2rem!important}.is-size-4-mobile{font-size:1.5rem!important}.is-size-5-mobile{font-size:1.25rem!important}.is-size-6-mobile{font-size:1rem!important}.is-size-7-mobile{font-size:.75rem!important}}@media screen and (min-width:769px),print{.is-size-1-tablet{font-size:3rem!important}.is-size-2-tablet{font-size:2.5rem!important}.is-size-3-tablet{font-size:2rem!important}.is-size-4-tablet{font-size:1.5rem!important}.is-size-5-tablet{font-size:1.25rem!important}.is-size-6-tablet{font-size:1rem!important}.is-size-7-tablet{font-size:.75rem!important}}@media screen and (max-width:1023px){.is-size-1-touch{font-size:3rem!important}.is-size-2-touch{font-size:2.5rem!important}.is-size-3-touch{font-size:2rem!important}.is-size-4-touch{font-size:1.5rem!important}.is-size-5-touch{font-size:1.25rem!important}.is-size-6-touch{font-size:1rem!important}.is-size-7-touch{font-size:.75rem!important}}@media screen and (min-width:1024px){.is-size-1-desktop{font-size:3rem!important}.is-size-2-desktop{font-size:2.5rem!important}.is-size-3-desktop{font-size:2rem!important}.is-size-4-desktop{font-size:1.5rem!important}.is-size-5-desktop{font-size:1.25rem!important}.is-size-6-desktop{font-size:1rem!important}.is-size-7-desktop{font-size:.75rem!important}}@media screen and (min-width:1216px){.is-size-1-widescreen{font-size:3rem!important}.is-size-2-widescreen{font-size:2.5rem!important}.is-size-3-widescreen{font-size:2rem!important}.is-size-4-widescreen{font-size:1.5rem!important}.is-size-5-widescreen{font-size:1.25rem!important}.is-size-6-widescreen{font-size:1rem!important}.is-size-7-widescreen{font-size:.75rem!important}}@media screen and (min-width:1408px){.is-size-1-fullhd{font-size:3rem!important}.is-size-2-fullhd{font-size:2.5rem!important}.is-size-3-fullhd{font-size:2rem!important}.is-size-4-fullhd{font-size:1.5rem!important}.is-size-5-fullhd{font-size:1.25rem!important}.is-size-6-fullhd{font-size:1rem!important}.is-size-7-fullhd{font-size:.75rem!important}}.has-text-centered{text-align:center!important}.has-text-justified{text-align:justify!important}.has-text-left{text-align:left!important}.has-text-right{text-align:right!important}@media screen and (max-width:768px){.has-text-centered-mobile{text-align:center!important}}@media screen and (min-width:769px),print{.has-text-centered-tablet{text-align:center!important}}@media screen and (min-width:769px) and (max-width:1023px){.has-text-centered-tablet-only{text-align:center!important}}@media screen and (max-width:1023px){.has-text-centered-touch{text-align:center!important}}@media screen and (min-width:1024px){.has-text-centered-desktop{text-align:center!important}}@media screen and (min-width:1024px) and (max-width:1215px){.has-text-centered-desktop-only{text-align:center!important}}@media screen and (min-width:1216px){.has-text-centered-widescreen{text-align:center!important}}@media screen and (min-width:1216px) and (max-width:1407px){.has-text-centered-widescreen-only{text-align:center!important}}@media screen and (min-width:1408px){.has-text-centered-fullhd{text-align:center!important}}@media screen and (max-width:768px){.has-text-justified-mobile{text-align:justify!important}}@media screen and (min-width:769px),print{.has-text-justified-tablet{text-align:justify!important}}@media screen and (min-width:769px) and (max-width:1023px){.has-text-justified-tablet-only{text-align:justify!important}}@media screen and (max-width:1023px){.has-text-justified-touch{text-align:justify!important}}@media screen and (min-width:1024px){.has-text-justified-desktop{text-align:justify!important}}@media screen and (min-width:1024px) and (max-width:1215px){.has-text-justified-desktop-only{text-align:justify!important}}@media screen and (min-width:1216px){.has-text-justified-widescreen{text-align:justify!important}}@media screen and (min-width:1216px) and (max-width:1407px){.has-text-justified-widescreen-only{text-align:justify!important}}@media screen and (min-width:1408px){.has-text-justified-fullhd{text-align:justify!important}}@media screen and (max-width:768px){.has-text-left-mobile{text-align:left!important}}@media screen and (min-width:769px),print{.has-text-left-tablet{text-align:left!important}}@media screen and (min-width:769px) and (max-width:1023px){.has-text-left-tablet-only{text-align:left!important}}@media screen and (max-width:1023px){.has-text-left-touch{text-align:left!important}}@media screen and (min-width:1024px){.has-text-left-desktop{text-align:left!important}}@media screen and (min-width:1024px) and (max-width:1215px){.has-text-left-desktop-only{text-align:left!important}}@media screen and (min-width:1216px){.has-text-left-widescreen{text-align:left!important}}@media screen and (min-width:1216px) and (max-width:1407px){.has-text-left-widescreen-only{text-align:left!important}}@media screen and (min-width:1408px){.has-text-left-fullhd{text-align:left!important}}@media screen and (max-width:768px){.has-text-right-mobile{text-align:right!important}}@media screen and (min-width:769px),print{.has-text-right-tablet{text-align:right!important}}@media screen and (min-width:769px) and (max-width:1023px){.has-text-right-tablet-only{text-align:right!important}}@media screen and (max-width:1023px){.has-text-right-touch{text-align:right!important}}@media screen and (min-width:1024px){.has-text-right-desktop{text-align:right!important}}@media screen and (min-width:1024px) and (max-width:1215px){.has-text-right-desktop-only{text-align:right!important}}@media screen and (min-width:1216px){.has-text-right-widescreen{text-align:right!important}}@media screen and (min-width:1216px) and (max-width:1407px){.has-text-right-widescreen-only{text-align:right!important}}@media screen and (min-width:1408px){.has-text-right-fullhd{text-align:right!important}}.is-capitalized{text-transform:capitalize!important}.is-lowercase{text-transform:lowercase!important}.is-uppercase{text-transform:uppercase!important}.is-italic{font-style:italic!important}.is-underlined{text-decoration:underline!important}.has-text-weight-light{font-weight:300!important}.has-text-weight-normal{font-weight:400!important}.has-text-weight-medium{font-weight:500!important}.has-text-weight-semibold{font-weight:600!important}.has-text-weight-bold{font-weight:700!important}.is-family-primary{font-family:BlinkMacSystemFont,-apple-system,\"Segoe UI\",Roboto,Oxygen,Ubuntu,Cantarell,\"Fira Sans\",\"Droid Sans\",\"Helvetica Neue\",Helvetica,Arial,sans-serif!important}.is-family-secondary{font-family:BlinkMacSystemFont,-apple-system,\"Segoe UI\",Roboto,Oxygen,Ubuntu,Cantarell,\"Fira Sans\",\"Droid Sans\",\"Helvetica Neue\",Helvetica,Arial,sans-serif!important}.is-family-sans-serif{font-family:BlinkMacSystemFont,-apple-system,\"Segoe UI\",Roboto,Oxygen,Ubuntu,Cantarell,\"Fira Sans\",\"Droid Sans\",\"Helvetica Neue\",Helvetica,Arial,sans-serif!important}.is-family-monospace{font-family:monospace!important}.is-family-code{font-family:monospace!important}.is-block{display:block!important}@media screen and (max-width:768px){.is-block-mobile{display:block!important}}@media screen and (min-width:769px),print{.is-block-tablet{display:block!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-block-tablet-only{display:block!important}}@media screen and (max-width:1023px){.is-block-touch{display:block!important}}@media screen and (min-width:1024px){.is-block-desktop{display:block!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-block-desktop-only{display:block!important}}@media screen and (min-width:1216px){.is-block-widescreen{display:block!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-block-widescreen-only{display:block!important}}@media screen and (min-width:1408px){.is-block-fullhd{display:block!important}}.is-flex{display:flex!important}@media screen and (max-width:768px){.is-flex-mobile{display:flex!important}}@media screen and (min-width:769px),print{.is-flex-tablet{display:flex!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-flex-tablet-only{display:flex!important}}@media screen and (max-width:1023px){.is-flex-touch{display:flex!important}}@media screen and (min-width:1024px){.is-flex-desktop{display:flex!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-flex-desktop-only{display:flex!important}}@media screen and (min-width:1216px){.is-flex-widescreen{display:flex!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-flex-widescreen-only{display:flex!important}}@media screen and (min-width:1408px){.is-flex-fullhd{display:flex!important}}.is-inline{display:inline!important}@media screen and (max-width:768px){.is-inline-mobile{display:inline!important}}@media screen and (min-width:769px),print{.is-inline-tablet{display:inline!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-inline-tablet-only{display:inline!important}}@media screen and (max-width:1023px){.is-inline-touch{display:inline!important}}@media screen and (min-width:1024px){.is-inline-desktop{display:inline!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-inline-desktop-only{display:inline!important}}@media screen and (min-width:1216px){.is-inline-widescreen{display:inline!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-inline-widescreen-only{display:inline!important}}@media screen and (min-width:1408px){.is-inline-fullhd{display:inline!important}}.is-inline-block{display:inline-block!important}@media screen and (max-width:768px){.is-inline-block-mobile{display:inline-block!important}}@media screen and (min-width:769px),print{.is-inline-block-tablet{display:inline-block!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-inline-block-tablet-only{display:inline-block!important}}@media screen and (max-width:1023px){.is-inline-block-touch{display:inline-block!important}}@media screen and (min-width:1024px){.is-inline-block-desktop{display:inline-block!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-inline-block-desktop-only{display:inline-block!important}}@media screen and (min-width:1216px){.is-inline-block-widescreen{display:inline-block!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-inline-block-widescreen-only{display:inline-block!important}}@media screen and (min-width:1408px){.is-inline-block-fullhd{display:inline-block!important}}.is-inline-flex{display:inline-flex!important}@media screen and (max-width:768px){.is-inline-flex-mobile{display:inline-flex!important}}@media screen and (min-width:769px),print{.is-inline-flex-tablet{display:inline-flex!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-inline-flex-tablet-only{display:inline-flex!important}}@media screen and (max-width:1023px){.is-inline-flex-touch{display:inline-flex!important}}@media screen and (min-width:1024px){.is-inline-flex-desktop{display:inline-flex!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-inline-flex-desktop-only{display:inline-flex!important}}@media screen and (min-width:1216px){.is-inline-flex-widescreen{display:inline-flex!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-inline-flex-widescreen-only{display:inline-flex!important}}@media screen and (min-width:1408px){.is-inline-flex-fullhd{display:inline-flex!important}}.is-hidden{display:none!important}.is-sr-only{border:none!important;clip:rect(0,0,0,0)!important;height:.01em!important;overflow:hidden!important;padding:0!important;position:absolute!important;white-space:nowrap!important;width:.01em!important}@media screen and (max-width:768px){.is-hidden-mobile{display:none!important}}@media screen and (min-width:769px),print{.is-hidden-tablet{display:none!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-hidden-tablet-only{display:none!important}}@media screen and (max-width:1023px){.is-hidden-touch{display:none!important}}@media screen and (min-width:1024px){.is-hidden-desktop{display:none!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-hidden-desktop-only{display:none!important}}@media screen and (min-width:1216px){.is-hidden-widescreen{display:none!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-hidden-widescreen-only{display:none!important}}@media screen and (min-width:1408px){.is-hidden-fullhd{display:none!important}}.is-invisible{visibility:hidden!important}@media screen and (max-width:768px){.is-invisible-mobile{visibility:hidden!important}}@media screen and (min-width:769px),print{.is-invisible-tablet{visibility:hidden!important}}@media screen and (min-width:769px) and (max-width:1023px){.is-invisible-tablet-only{visibility:hidden!important}}@media screen and (max-width:1023px){.is-invisible-touch{visibility:hidden!important}}@media screen and (min-width:1024px){.is-invisible-desktop{visibility:hidden!important}}@media screen and (min-width:1024px) and (max-width:1215px){.is-invisible-desktop-only{visibility:hidden!important}}@media screen and (min-width:1216px){.is-invisible-widescreen{visibility:hidden!important}}@media screen and (min-width:1216px) and (max-width:1407px){.is-invisible-widescreen-only{visibility:hidden!important}}@media screen and (min-width:1408px){.is-invisible-fullhd{visibility:hidden!important}}.hero{align-items:stretch;display:flex;flex-direction:column;justify-content:space-between}.hero .navbar{background:0 0}.hero .tabs ul{border-bottom:none}.hero.is-white{background-color:#fff;color:#0a0a0a}.hero.is-white a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-white strong{color:inherit}.hero.is-white .title{color:#0a0a0a}.hero.is-white .subtitle{color:rgba(10,10,10,.9)}.hero.is-white .subtitle a:not(.button),.hero.is-white .subtitle strong{color:#0a0a0a}@media screen and (max-width:1023px){.hero.is-white .navbar-menu{background-color:#fff}}.hero.is-white .navbar-item,.hero.is-white .navbar-link{color:rgba(10,10,10,.7)}.hero.is-white .navbar-link.is-active,.hero.is-white .navbar-link:hover,.hero.is-white a.navbar-item.is-active,.hero.is-white a.navbar-item:hover{background-color:#f2f2f2;color:#0a0a0a}.hero.is-white .tabs a{color:#0a0a0a;opacity:.9}.hero.is-white .tabs a:hover{opacity:1}.hero.is-white .tabs li.is-active a{color:#fff!important;opacity:1}.hero.is-white .tabs.is-boxed a,.hero.is-white .tabs.is-toggle a{color:#0a0a0a}.hero.is-white .tabs.is-boxed a:hover,.hero.is-white .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-white .tabs.is-boxed li.is-active a,.hero.is-white .tabs.is-boxed li.is-active a:hover,.hero.is-white .tabs.is-toggle li.is-active a,.hero.is-white .tabs.is-toggle li.is-active a:hover{background-color:#0a0a0a;border-color:#0a0a0a;color:#fff}.hero.is-white.is-bold{background-image:linear-gradient(141deg,#e6e6e6 0,#fff 71%,#fff 100%)}@media screen and (max-width:768px){.hero.is-white.is-bold .navbar-menu{background-image:linear-gradient(141deg,#e6e6e6 0,#fff 71%,#fff 100%)}}.hero.is-black{background-color:#0a0a0a;color:#fff}.hero.is-black a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-black strong{color:inherit}.hero.is-black .title{color:#fff}.hero.is-black .subtitle{color:rgba(255,255,255,.9)}.hero.is-black .subtitle a:not(.button),.hero.is-black .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-black .navbar-menu{background-color:#0a0a0a}}.hero.is-black .navbar-item,.hero.is-black .navbar-link{color:rgba(255,255,255,.7)}.hero.is-black .navbar-link.is-active,.hero.is-black .navbar-link:hover,.hero.is-black a.navbar-item.is-active,.hero.is-black a.navbar-item:hover{background-color:#000;color:#fff}.hero.is-black .tabs a{color:#fff;opacity:.9}.hero.is-black .tabs a:hover{opacity:1}.hero.is-black .tabs li.is-active a{color:#0a0a0a!important;opacity:1}.hero.is-black .tabs.is-boxed a,.hero.is-black .tabs.is-toggle a{color:#fff}.hero.is-black .tabs.is-boxed a:hover,.hero.is-black .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-black .tabs.is-boxed li.is-active a,.hero.is-black .tabs.is-boxed li.is-active a:hover,.hero.is-black .tabs.is-toggle li.is-active a,.hero.is-black .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#0a0a0a}.hero.is-black.is-bold{background-image:linear-gradient(141deg,#000 0,#0a0a0a 71%,#181616 100%)}@media screen and (max-width:768px){.hero.is-black.is-bold .navbar-menu{background-image:linear-gradient(141deg,#000 0,#0a0a0a 71%,#181616 100%)}}.hero.is-light{background-color:#f5f5f5;color:rgba(0,0,0,.7)}.hero.is-light a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-light strong{color:inherit}.hero.is-light .title{color:rgba(0,0,0,.7)}.hero.is-light .subtitle{color:rgba(0,0,0,.9)}.hero.is-light .subtitle a:not(.button),.hero.is-light .subtitle strong{color:rgba(0,0,0,.7)}@media screen and (max-width:1023px){.hero.is-light .navbar-menu{background-color:#f5f5f5}}.hero.is-light .navbar-item,.hero.is-light .navbar-link{color:rgba(0,0,0,.7)}.hero.is-light .navbar-link.is-active,.hero.is-light .navbar-link:hover,.hero.is-light a.navbar-item.is-active,.hero.is-light a.navbar-item:hover{background-color:#e8e8e8;color:rgba(0,0,0,.7)}.hero.is-light .tabs a{color:rgba(0,0,0,.7);opacity:.9}.hero.is-light .tabs a:hover{opacity:1}.hero.is-light .tabs li.is-active a{color:#f5f5f5!important;opacity:1}.hero.is-light .tabs.is-boxed a,.hero.is-light .tabs.is-toggle a{color:rgba(0,0,0,.7)}.hero.is-light .tabs.is-boxed a:hover,.hero.is-light .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-light .tabs.is-boxed li.is-active a,.hero.is-light .tabs.is-boxed li.is-active a:hover,.hero.is-light .tabs.is-toggle li.is-active a,.hero.is-light .tabs.is-toggle li.is-active a:hover{background-color:rgba(0,0,0,.7);border-color:rgba(0,0,0,.7);color:#f5f5f5}.hero.is-light.is-bold{background-image:linear-gradient(141deg,#dfd8d9 0,#f5f5f5 71%,#fff 100%)}@media screen and (max-width:768px){.hero.is-light.is-bold .navbar-menu{background-image:linear-gradient(141deg,#dfd8d9 0,#f5f5f5 71%,#fff 100%)}}.hero.is-dark{background-color:#363636;color:#fff}.hero.is-dark a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-dark strong{color:inherit}.hero.is-dark .title{color:#fff}.hero.is-dark .subtitle{color:rgba(255,255,255,.9)}.hero.is-dark .subtitle a:not(.button),.hero.is-dark .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-dark .navbar-menu{background-color:#363636}}.hero.is-dark .navbar-item,.hero.is-dark .navbar-link{color:rgba(255,255,255,.7)}.hero.is-dark .navbar-link.is-active,.hero.is-dark .navbar-link:hover,.hero.is-dark a.navbar-item.is-active,.hero.is-dark a.navbar-item:hover{background-color:#292929;color:#fff}.hero.is-dark .tabs a{color:#fff;opacity:.9}.hero.is-dark .tabs a:hover{opacity:1}.hero.is-dark .tabs li.is-active a{color:#363636!important;opacity:1}.hero.is-dark .tabs.is-boxed a,.hero.is-dark .tabs.is-toggle a{color:#fff}.hero.is-dark .tabs.is-boxed a:hover,.hero.is-dark .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-dark .tabs.is-boxed li.is-active a,.hero.is-dark .tabs.is-boxed li.is-active a:hover,.hero.is-dark .tabs.is-toggle li.is-active a,.hero.is-dark .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#363636}.hero.is-dark.is-bold{background-image:linear-gradient(141deg,#1f191a 0,#363636 71%,#46403f 100%)}@media screen and (max-width:768px){.hero.is-dark.is-bold .navbar-menu{background-image:linear-gradient(141deg,#1f191a 0,#363636 71%,#46403f 100%)}}.hero.is-primary{background-color:#00d1b2;color:#fff}.hero.is-primary a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-primary strong{color:inherit}.hero.is-primary .title{color:#fff}.hero.is-primary .subtitle{color:rgba(255,255,255,.9)}.hero.is-primary .subtitle a:not(.button),.hero.is-primary .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-primary .navbar-menu{background-color:#00d1b2}}.hero.is-primary .navbar-item,.hero.is-primary .navbar-link{color:rgba(255,255,255,.7)}.hero.is-primary .navbar-link.is-active,.hero.is-primary .navbar-link:hover,.hero.is-primary a.navbar-item.is-active,.hero.is-primary a.navbar-item:hover{background-color:#00b89c;color:#fff}.hero.is-primary .tabs a{color:#fff;opacity:.9}.hero.is-primary .tabs a:hover{opacity:1}.hero.is-primary .tabs li.is-active a{color:#00d1b2!important;opacity:1}.hero.is-primary .tabs.is-boxed a,.hero.is-primary .tabs.is-toggle a{color:#fff}.hero.is-primary .tabs.is-boxed a:hover,.hero.is-primary .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-primary .tabs.is-boxed li.is-active a,.hero.is-primary .tabs.is-boxed li.is-active a:hover,.hero.is-primary .tabs.is-toggle li.is-active a,.hero.is-primary .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#00d1b2}.hero.is-primary.is-bold{background-image:linear-gradient(141deg,#009e6c 0,#00d1b2 71%,#00e7eb 100%)}@media screen and (max-width:768px){.hero.is-primary.is-bold .navbar-menu{background-image:linear-gradient(141deg,#009e6c 0,#00d1b2 71%,#00e7eb 100%)}}.hero.is-link{background-color:#485fc7;color:#fff}.hero.is-link a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-link strong{color:inherit}.hero.is-link .title{color:#fff}.hero.is-link .subtitle{color:rgba(255,255,255,.9)}.hero.is-link .subtitle a:not(.button),.hero.is-link .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-link .navbar-menu{background-color:#485fc7}}.hero.is-link .navbar-item,.hero.is-link .navbar-link{color:rgba(255,255,255,.7)}.hero.is-link .navbar-link.is-active,.hero.is-link .navbar-link:hover,.hero.is-link a.navbar-item.is-active,.hero.is-link a.navbar-item:hover{background-color:#3a51bb;color:#fff}.hero.is-link .tabs a{color:#fff;opacity:.9}.hero.is-link .tabs a:hover{opacity:1}.hero.is-link .tabs li.is-active a{color:#485fc7!important;opacity:1}.hero.is-link .tabs.is-boxed a,.hero.is-link .tabs.is-toggle a{color:#fff}.hero.is-link .tabs.is-boxed a:hover,.hero.is-link .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-link .tabs.is-boxed li.is-active a,.hero.is-link .tabs.is-boxed li.is-active a:hover,.hero.is-link .tabs.is-toggle li.is-active a,.hero.is-link .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#485fc7}.hero.is-link.is-bold{background-image:linear-gradient(141deg,#2959b3 0,#485fc7 71%,#5658d2 100%)}@media screen and (max-width:768px){.hero.is-link.is-bold .navbar-menu{background-image:linear-gradient(141deg,#2959b3 0,#485fc7 71%,#5658d2 100%)}}.hero.is-info{background-color:#3e8ed0;color:#fff}.hero.is-info a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-info strong{color:inherit}.hero.is-info .title{color:#fff}.hero.is-info .subtitle{color:rgba(255,255,255,.9)}.hero.is-info .subtitle a:not(.button),.hero.is-info .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-info .navbar-menu{background-color:#3e8ed0}}.hero.is-info .navbar-item,.hero.is-info .navbar-link{color:rgba(255,255,255,.7)}.hero.is-info .navbar-link.is-active,.hero.is-info .navbar-link:hover,.hero.is-info a.navbar-item.is-active,.hero.is-info a.navbar-item:hover{background-color:#3082c5;color:#fff}.hero.is-info .tabs a{color:#fff;opacity:.9}.hero.is-info .tabs a:hover{opacity:1}.hero.is-info .tabs li.is-active a{color:#3e8ed0!important;opacity:1}.hero.is-info .tabs.is-boxed a,.hero.is-info .tabs.is-toggle a{color:#fff}.hero.is-info .tabs.is-boxed a:hover,.hero.is-info .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-info .tabs.is-boxed li.is-active a,.hero.is-info .tabs.is-boxed li.is-active a:hover,.hero.is-info .tabs.is-toggle li.is-active a,.hero.is-info .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#3e8ed0}.hero.is-info.is-bold{background-image:linear-gradient(141deg,#208fbc 0,#3e8ed0 71%,#4d83db 100%)}@media screen and (max-width:768px){.hero.is-info.is-bold .navbar-menu{background-image:linear-gradient(141deg,#208fbc 0,#3e8ed0 71%,#4d83db 100%)}}.hero.is-success{background-color:#48c78e;color:#fff}.hero.is-success a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-success strong{color:inherit}.hero.is-success .title{color:#fff}.hero.is-success .subtitle{color:rgba(255,255,255,.9)}.hero.is-success .subtitle a:not(.button),.hero.is-success .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-success .navbar-menu{background-color:#48c78e}}.hero.is-success .navbar-item,.hero.is-success .navbar-link{color:rgba(255,255,255,.7)}.hero.is-success .navbar-link.is-active,.hero.is-success .navbar-link:hover,.hero.is-success a.navbar-item.is-active,.hero.is-success a.navbar-item:hover{background-color:#3abb81;color:#fff}.hero.is-success .tabs a{color:#fff;opacity:.9}.hero.is-success .tabs a:hover{opacity:1}.hero.is-success .tabs li.is-active a{color:#48c78e!important;opacity:1}.hero.is-success .tabs.is-boxed a,.hero.is-success .tabs.is-toggle a{color:#fff}.hero.is-success .tabs.is-boxed a:hover,.hero.is-success .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-success .tabs.is-boxed li.is-active a,.hero.is-success .tabs.is-boxed li.is-active a:hover,.hero.is-success .tabs.is-toggle li.is-active a,.hero.is-success .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#48c78e}.hero.is-success.is-bold{background-image:linear-gradient(141deg,#29b35e 0,#48c78e 71%,#56d2af 100%)}@media screen and (max-width:768px){.hero.is-success.is-bold .navbar-menu{background-image:linear-gradient(141deg,#29b35e 0,#48c78e 71%,#56d2af 100%)}}.hero.is-warning{background-color:#ffe08a;color:rgba(0,0,0,.7)}.hero.is-warning a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-warning strong{color:inherit}.hero.is-warning .title{color:rgba(0,0,0,.7)}.hero.is-warning .subtitle{color:rgba(0,0,0,.9)}.hero.is-warning .subtitle a:not(.button),.hero.is-warning .subtitle strong{color:rgba(0,0,0,.7)}@media screen and (max-width:1023px){.hero.is-warning .navbar-menu{background-color:#ffe08a}}.hero.is-warning .navbar-item,.hero.is-warning .navbar-link{color:rgba(0,0,0,.7)}.hero.is-warning .navbar-link.is-active,.hero.is-warning .navbar-link:hover,.hero.is-warning a.navbar-item.is-active,.hero.is-warning a.navbar-item:hover{background-color:#ffd970;color:rgba(0,0,0,.7)}.hero.is-warning .tabs a{color:rgba(0,0,0,.7);opacity:.9}.hero.is-warning .tabs a:hover{opacity:1}.hero.is-warning .tabs li.is-active a{color:#ffe08a!important;opacity:1}.hero.is-warning .tabs.is-boxed a,.hero.is-warning .tabs.is-toggle a{color:rgba(0,0,0,.7)}.hero.is-warning .tabs.is-boxed a:hover,.hero.is-warning .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-warning .tabs.is-boxed li.is-active a,.hero.is-warning .tabs.is-boxed li.is-active a:hover,.hero.is-warning .tabs.is-toggle li.is-active a,.hero.is-warning .tabs.is-toggle li.is-active a:hover{background-color:rgba(0,0,0,.7);border-color:rgba(0,0,0,.7);color:#ffe08a}.hero.is-warning.is-bold{background-image:linear-gradient(141deg,#ffb657 0,#ffe08a 71%,#fff6a3 100%)}@media screen and (max-width:768px){.hero.is-warning.is-bold .navbar-menu{background-image:linear-gradient(141deg,#ffb657 0,#ffe08a 71%,#fff6a3 100%)}}.hero.is-danger{background-color:#f14668;color:#fff}.hero.is-danger a:not(.button):not(.dropdown-item):not(.tag):not(.pagination-link.is-current),.hero.is-danger strong{color:inherit}.hero.is-danger .title{color:#fff}.hero.is-danger .subtitle{color:rgba(255,255,255,.9)}.hero.is-danger .subtitle a:not(.button),.hero.is-danger .subtitle strong{color:#fff}@media screen and (max-width:1023px){.hero.is-danger .navbar-menu{background-color:#f14668}}.hero.is-danger .navbar-item,.hero.is-danger .navbar-link{color:rgba(255,255,255,.7)}.hero.is-danger .navbar-link.is-active,.hero.is-danger .navbar-link:hover,.hero.is-danger a.navbar-item.is-active,.hero.is-danger a.navbar-item:hover{background-color:#ef2e55;color:#fff}.hero.is-danger .tabs a{color:#fff;opacity:.9}.hero.is-danger .tabs a:hover{opacity:1}.hero.is-danger .tabs li.is-active a{color:#f14668!important;opacity:1}.hero.is-danger .tabs.is-boxed a,.hero.is-danger .tabs.is-toggle a{color:#fff}.hero.is-danger .tabs.is-boxed a:hover,.hero.is-danger .tabs.is-toggle a:hover{background-color:rgba(10,10,10,.1)}.hero.is-danger .tabs.is-boxed li.is-active a,.hero.is-danger .tabs.is-boxed li.is-active a:hover,.hero.is-danger .tabs.is-toggle li.is-active a,.hero.is-danger .tabs.is-toggle li.is-active a:hover{background-color:#fff;border-color:#fff;color:#f14668}.hero.is-danger.is-bold{background-image:linear-gradient(141deg,#fa0a62 0,#f14668 71%,#f7595f 100%)}@media screen and (max-width:768px){.hero.is-danger.is-bold .navbar-menu{background-image:linear-gradient(141deg,#fa0a62 0,#f14668 71%,#f7595f 100%)}}.hero.is-small .hero-body{padding:1.5rem}@media screen and (min-width:769px),print{.hero.is-medium .hero-body{padding:9rem 4.5rem}}@media screen and (min-width:769px),print{.hero.is-large .hero-body{padding:18rem 6rem}}.hero.is-fullheight .hero-body,.hero.is-fullheight-with-navbar .hero-body,.hero.is-halfheight .hero-body{align-items:center;display:flex}.hero.is-fullheight .hero-body>.container,.hero.is-fullheight-with-navbar .hero-body>.container,.hero.is-halfheight .hero-body>.container{flex-grow:1;flex-shrink:1}.hero.is-halfheight{min-height:50vh}.hero.is-fullheight{min-height:100vh}.hero-video{overflow:hidden}.hero-video video{left:50%;min-height:100%;min-width:100%;position:absolute;top:50%;transform:translate3d(-50%,-50%,0)}.hero-video.is-transparent{opacity:.3}@media screen and (max-width:768px){.hero-video{display:none}}.hero-buttons{margin-top:1.5rem}@media screen and (max-width:768px){.hero-buttons .button{display:flex}.hero-buttons .button:not(:last-child){margin-bottom:.75rem}}@media screen and (min-width:769px),print{.hero-buttons{display:flex;justify-content:center}.hero-buttons .button:not(:last-child){margin-right:1.5rem}}.hero-foot,.hero-head{flex-grow:0;flex-shrink:0}.hero-body{flex-grow:1;flex-shrink:0;padding:3rem 1.5rem}@media screen and (min-width:769px),print{.hero-body{padding:3rem 3rem}}.section{padding:3rem 1.5rem}@media screen and (min-width:1024px){.section{padding:3rem 3rem}.section.is-medium{padding:9rem 4.5rem}.section.is-large{padding:18rem 6rem}}.footer{background-color:#fafafa;padding:3rem 1.5rem 6rem}";
    styleInject(css_248z$4);

    /* node_modules/svelte-feather-icons/src/icons/BarChart2Icon.svelte generated by Svelte v3.49.0 */

    const file$b = "node_modules/svelte-feather-icons/src/icons/BarChart2Icon.svelte";

    function create_fragment$b(ctx) {
    	let svg;
    	let line0;
    	let line1;
    	let line2;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			line0 = svg_element("line");
    			line1 = svg_element("line");
    			line2 = svg_element("line");
    			attr_dev(line0, "x1", "18");
    			attr_dev(line0, "y1", "20");
    			attr_dev(line0, "x2", "18");
    			attr_dev(line0, "y2", "10");
    			add_location(line0, file$b, 13, 248, 534);
    			attr_dev(line1, "x1", "12");
    			attr_dev(line1, "y1", "20");
    			attr_dev(line1, "x2", "12");
    			attr_dev(line1, "y2", "4");
    			add_location(line1, file$b, 13, 293, 579);
    			attr_dev(line2, "x1", "6");
    			attr_dev(line2, "y1", "20");
    			attr_dev(line2, "x2", "6");
    			attr_dev(line2, "y2", "14");
    			add_location(line2, file$b, 13, 337, 623);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-bar-chart-2 " + /*customClass*/ ctx[2]);
    			add_location(svg, file$b, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, line0);
    			append_dev(svg, line1);
    			append_dev(svg, line2);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-bar-chart-2 " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$b.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$b($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('BarChart2Icon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<BarChart2Icon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class BarChart2Icon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$b, create_fragment$b, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "BarChart2Icon",
    			options,
    			id: create_fragment$b.name
    		});
    	}

    	get size() {
    		throw new Error("<BarChart2Icon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<BarChart2Icon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<BarChart2Icon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<BarChart2Icon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<BarChart2Icon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<BarChart2Icon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/CornerDownLeftIcon.svelte generated by Svelte v3.49.0 */

    const file$a = "node_modules/svelte-feather-icons/src/icons/CornerDownLeftIcon.svelte";

    function create_fragment$a(ctx) {
    	let svg;
    	let polyline;
    	let path;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			polyline = svg_element("polyline");
    			path = svg_element("path");
    			attr_dev(polyline, "points", "9 10 4 15 9 20");
    			add_location(polyline, file$a, 13, 253, 539);
    			attr_dev(path, "d", "M20 4v7a4 4 0 0 1-4 4H4");
    			add_location(path, file$a, 13, 298, 584);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-corner-down-left " + /*customClass*/ ctx[2]);
    			add_location(svg, file$a, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, polyline);
    			append_dev(svg, path);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-corner-down-left " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$a.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$a($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('CornerDownLeftIcon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<CornerDownLeftIcon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class CornerDownLeftIcon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$a, create_fragment$a, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "CornerDownLeftIcon",
    			options,
    			id: create_fragment$a.name
    		});
    	}

    	get size() {
    		throw new Error("<CornerDownLeftIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<CornerDownLeftIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<CornerDownLeftIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<CornerDownLeftIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<CornerDownLeftIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<CornerDownLeftIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/RefreshCwIcon.svelte generated by Svelte v3.49.0 */

    const file$9 = "node_modules/svelte-feather-icons/src/icons/RefreshCwIcon.svelte";

    function create_fragment$9(ctx) {
    	let svg;
    	let polyline0;
    	let polyline1;
    	let path;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			polyline0 = svg_element("polyline");
    			polyline1 = svg_element("polyline");
    			path = svg_element("path");
    			attr_dev(polyline0, "points", "23 4 23 10 17 10");
    			add_location(polyline0, file$9, 13, 247, 533);
    			attr_dev(polyline1, "points", "1 20 1 14 7 14");
    			add_location(polyline1, file$9, 13, 294, 580);
    			attr_dev(path, "d", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15");
    			add_location(path, file$9, 13, 339, 625);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-refresh-cw " + /*customClass*/ ctx[2]);
    			add_location(svg, file$9, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, polyline0);
    			append_dev(svg, polyline1);
    			append_dev(svg, path);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-refresh-cw " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$9.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$9($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('RefreshCwIcon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<RefreshCwIcon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class RefreshCwIcon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$9, create_fragment$9, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "RefreshCwIcon",
    			options,
    			id: create_fragment$9.name
    		});
    	}

    	get size() {
    		throw new Error("<RefreshCwIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<RefreshCwIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<RefreshCwIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<RefreshCwIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<RefreshCwIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<RefreshCwIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/RepeatIcon.svelte generated by Svelte v3.49.0 */

    const file$8 = "node_modules/svelte-feather-icons/src/icons/RepeatIcon.svelte";

    function create_fragment$8(ctx) {
    	let svg;
    	let polyline0;
    	let path0;
    	let polyline1;
    	let path1;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			polyline0 = svg_element("polyline");
    			path0 = svg_element("path");
    			polyline1 = svg_element("polyline");
    			path1 = svg_element("path");
    			attr_dev(polyline0, "points", "17 1 21 5 17 9");
    			add_location(polyline0, file$8, 13, 243, 529);
    			attr_dev(path0, "d", "M3 11V9a4 4 0 0 1 4-4h14");
    			add_location(path0, file$8, 13, 288, 574);
    			attr_dev(polyline1, "points", "7 23 3 19 7 15");
    			add_location(polyline1, file$8, 13, 330, 616);
    			attr_dev(path1, "d", "M21 13v2a4 4 0 0 1-4 4H3");
    			add_location(path1, file$8, 13, 375, 661);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-repeat " + /*customClass*/ ctx[2]);
    			add_location(svg, file$8, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, polyline0);
    			append_dev(svg, path0);
    			append_dev(svg, polyline1);
    			append_dev(svg, path1);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-repeat " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$8.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$8($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('RepeatIcon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<RepeatIcon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class RepeatIcon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$8, create_fragment$8, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "RepeatIcon",
    			options,
    			id: create_fragment$8.name
    		});
    	}

    	get size() {
    		throw new Error("<RepeatIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<RepeatIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<RepeatIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<RepeatIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<RepeatIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<RepeatIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/SaveIcon.svelte generated by Svelte v3.49.0 */

    const file$7 = "node_modules/svelte-feather-icons/src/icons/SaveIcon.svelte";

    function create_fragment$7(ctx) {
    	let svg;
    	let path;
    	let polyline0;
    	let polyline1;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			path = svg_element("path");
    			polyline0 = svg_element("polyline");
    			polyline1 = svg_element("polyline");
    			attr_dev(path, "d", "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z");
    			add_location(path, file$7, 13, 241, 527);
    			attr_dev(polyline0, "points", "17 21 17 13 7 13 7 21");
    			add_location(polyline0, file$7, 13, 322, 608);
    			attr_dev(polyline1, "points", "7 3 7 8 15 8");
    			add_location(polyline1, file$7, 13, 374, 660);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-save " + /*customClass*/ ctx[2]);
    			add_location(svg, file$7, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, path);
    			append_dev(svg, polyline0);
    			append_dev(svg, polyline1);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-save " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$7.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$7($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('SaveIcon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<SaveIcon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class SaveIcon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$7, create_fragment$7, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "SaveIcon",
    			options,
    			id: create_fragment$7.name
    		});
    	}

    	get size() {
    		throw new Error("<SaveIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<SaveIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<SaveIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<SaveIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<SaveIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<SaveIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/SettingsIcon.svelte generated by Svelte v3.49.0 */

    const file$6 = "node_modules/svelte-feather-icons/src/icons/SettingsIcon.svelte";

    function create_fragment$6(ctx) {
    	let svg;
    	let circle;
    	let path;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			circle = svg_element("circle");
    			path = svg_element("path");
    			attr_dev(circle, "cx", "12");
    			attr_dev(circle, "cy", "12");
    			attr_dev(circle, "r", "3");
    			add_location(circle, file$6, 13, 245, 531);
    			attr_dev(path, "d", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z");
    			add_location(path, file$6, 13, 284, 570);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-settings " + /*customClass*/ ctx[2]);
    			add_location(svg, file$6, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, circle);
    			append_dev(svg, path);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-settings " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$6.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$6($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('SettingsIcon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<SettingsIcon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class SettingsIcon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$6, create_fragment$6, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "SettingsIcon",
    			options,
    			id: create_fragment$6.name
    		});
    	}

    	get size() {
    		throw new Error("<SettingsIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<SettingsIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<SettingsIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<SettingsIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<SettingsIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<SettingsIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/TerminalIcon.svelte generated by Svelte v3.49.0 */

    const file$5 = "node_modules/svelte-feather-icons/src/icons/TerminalIcon.svelte";

    function create_fragment$5(ctx) {
    	let svg;
    	let polyline;
    	let line;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			polyline = svg_element("polyline");
    			line = svg_element("line");
    			attr_dev(polyline, "points", "4 17 10 11 4 5");
    			add_location(polyline, file$5, 13, 245, 531);
    			attr_dev(line, "x1", "12");
    			attr_dev(line, "y1", "19");
    			attr_dev(line, "x2", "20");
    			attr_dev(line, "y2", "19");
    			add_location(line, file$5, 13, 290, 576);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-terminal " + /*customClass*/ ctx[2]);
    			add_location(svg, file$5, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, polyline);
    			append_dev(svg, line);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-terminal " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$5.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$5($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('TerminalIcon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<TerminalIcon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class TerminalIcon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$5, create_fragment$5, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "TerminalIcon",
    			options,
    			id: create_fragment$5.name
    		});
    	}

    	get size() {
    		throw new Error("<TerminalIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<TerminalIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<TerminalIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<TerminalIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<TerminalIcon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<TerminalIcon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    /* node_modules/svelte-feather-icons/src/icons/Trash2Icon.svelte generated by Svelte v3.49.0 */

    const file$4 = "node_modules/svelte-feather-icons/src/icons/Trash2Icon.svelte";

    function create_fragment$4(ctx) {
    	let svg;
    	let polyline;
    	let path;
    	let line0;
    	let line1;
    	let svg_class_value;

    	const block = {
    		c: function create() {
    			svg = svg_element("svg");
    			polyline = svg_element("polyline");
    			path = svg_element("path");
    			line0 = svg_element("line");
    			line1 = svg_element("line");
    			attr_dev(polyline, "points", "3 6 5 6 21 6");
    			add_location(polyline, file$4, 13, 244, 530);
    			attr_dev(path, "d", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2");
    			add_location(path, file$4, 13, 287, 573);
    			attr_dev(line0, "x1", "10");
    			attr_dev(line0, "y1", "11");
    			attr_dev(line0, "x2", "10");
    			attr_dev(line0, "y2", "17");
    			add_location(line0, file$4, 13, 383, 669);
    			attr_dev(line1, "x1", "14");
    			attr_dev(line1, "y1", "11");
    			attr_dev(line1, "x2", "14");
    			attr_dev(line1, "y2", "17");
    			add_location(line1, file$4, 13, 428, 714);
    			attr_dev(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr_dev(svg, "width", /*size*/ ctx[0]);
    			attr_dev(svg, "height", /*size*/ ctx[0]);
    			attr_dev(svg, "fill", "none");
    			attr_dev(svg, "viewBox", "0 0 24 24");
    			attr_dev(svg, "stroke", "currentColor");
    			attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			attr_dev(svg, "stroke-linecap", "round");
    			attr_dev(svg, "stroke-linejoin", "round");
    			attr_dev(svg, "class", svg_class_value = "feather feather-trash-2 " + /*customClass*/ ctx[2]);
    			add_location(svg, file$4, 13, 0, 286);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, svg, anchor);
    			append_dev(svg, polyline);
    			append_dev(svg, path);
    			append_dev(svg, line0);
    			append_dev(svg, line1);
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "width", /*size*/ ctx[0]);
    			}

    			if (dirty & /*size*/ 1) {
    				attr_dev(svg, "height", /*size*/ ctx[0]);
    			}

    			if (dirty & /*strokeWidth*/ 2) {
    				attr_dev(svg, "stroke-width", /*strokeWidth*/ ctx[1]);
    			}

    			if (dirty & /*customClass*/ 4 && svg_class_value !== (svg_class_value = "feather feather-trash-2 " + /*customClass*/ ctx[2])) {
    				attr_dev(svg, "class", svg_class_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(svg);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$4.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$4($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('Trash2Icon', slots, []);
    	let { size = "100%" } = $$props;
    	let { strokeWidth = 2 } = $$props;
    	let { class: customClass = "" } = $$props;

    	if (size !== "100%") {
    		size = size.slice(-1) === 'x'
    		? size.slice(0, size.length - 1) + 'em'
    		: parseInt(size) + 'px';
    	}

    	const writable_props = ['size', 'strokeWidth', 'class'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<Trash2Icon> was created with unknown prop '${key}'`);
    	});

    	$$self.$$set = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('class' in $$props) $$invalidate(2, customClass = $$props.class);
    	};

    	$$self.$capture_state = () => ({ size, strokeWidth, customClass });

    	$$self.$inject_state = $$props => {
    		if ('size' in $$props) $$invalidate(0, size = $$props.size);
    		if ('strokeWidth' in $$props) $$invalidate(1, strokeWidth = $$props.strokeWidth);
    		if ('customClass' in $$props) $$invalidate(2, customClass = $$props.customClass);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [size, strokeWidth, customClass];
    }

    class Trash2Icon extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$4, create_fragment$4, safe_not_equal, { size: 0, strokeWidth: 1, class: 2 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "Trash2Icon",
    			options,
    			id: create_fragment$4.name
    		});
    	}

    	get size() {
    		throw new Error("<Trash2Icon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set size(value) {
    		throw new Error("<Trash2Icon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get strokeWidth() {
    		throw new Error("<Trash2Icon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set strokeWidth(value) {
    		throw new Error("<Trash2Icon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get class() {
    		throw new Error("<Trash2Icon>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set class(value) {
    		throw new Error("<Trash2Icon>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    function unwrapExports (x) {
    	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
    }

    function createCommonjsModule(fn, module) {
    	return module = { exports: {} }, fn(module, module.exports), module.exports;
    }

    var xterm = createCommonjsModule(function (module, exports) {
    !function(e,t){module.exports=t();}(self,(function(){return (()=>{var e={4567:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.AccessibilityManager=void 0;var o=r(9042),s=r(6114),a=r(9924),c=r(3656),l=r(844),h=r(5596),u=r(9631),f=function(e){function t(t,r){var i=e.call(this)||this;i._terminal=t,i._renderService=r,i._liveRegionLineCount=0,i._charsToConsume=[],i._charsToAnnounce="",i._accessibilityTreeRoot=document.createElement("div"),i._accessibilityTreeRoot.classList.add("xterm-accessibility"),i._accessibilityTreeRoot.tabIndex=0,i._rowContainer=document.createElement("div"),i._rowContainer.setAttribute("role","list"),i._rowContainer.classList.add("xterm-accessibility-tree"),i._rowElements=[];for(var n=0;n<i._terminal.rows;n++)i._rowElements[n]=i._createAccessibilityTreeNode(),i._rowContainer.appendChild(i._rowElements[n]);if(i._topBoundaryFocusListener=function(e){return i._onBoundaryFocus(e,0)},i._bottomBoundaryFocusListener=function(e){return i._onBoundaryFocus(e,1)},i._rowElements[0].addEventListener("focus",i._topBoundaryFocusListener),i._rowElements[i._rowElements.length-1].addEventListener("focus",i._bottomBoundaryFocusListener),i._refreshRowsDimensions(),i._accessibilityTreeRoot.appendChild(i._rowContainer),i._renderRowsDebouncer=new a.TimeBasedDebouncer(i._renderRows.bind(i)),i._refreshRows(),i._liveRegion=document.createElement("div"),i._liveRegion.classList.add("live-region"),i._liveRegion.setAttribute("aria-live","assertive"),i._accessibilityTreeRoot.appendChild(i._liveRegion),!i._terminal.element)throw new Error("Cannot enable accessibility before Terminal.open");return i._terminal.element.insertAdjacentElement("afterbegin",i._accessibilityTreeRoot),i.register(i._renderRowsDebouncer),i.register(i._terminal.onResize((function(e){return i._onResize(e.rows)}))),i.register(i._terminal.onRender((function(e){return i._refreshRows(e.start,e.end)}))),i.register(i._terminal.onScroll((function(){return i._refreshRows()}))),i.register(i._terminal.onA11yChar((function(e){return i._onChar(e)}))),i.register(i._terminal.onLineFeed((function(){return i._onChar("\n")}))),i.register(i._terminal.onA11yTab((function(e){return i._onTab(e)}))),i.register(i._terminal.onKey((function(e){return i._onKey(e.key)}))),i.register(i._terminal.onBlur((function(){return i._clearLiveRegion()}))),i.register(i._renderService.onDimensionsChange((function(){return i._refreshRowsDimensions()}))),i._screenDprMonitor=new h.ScreenDprMonitor,i.register(i._screenDprMonitor),i._screenDprMonitor.setListener((function(){return i._refreshRowsDimensions()})),i.register((0, c.addDisposableDomListener)(window,"resize",(function(){return i._refreshRowsDimensions()}))),i}return n(t,e),t.prototype.dispose=function(){e.prototype.dispose.call(this),(0, u.removeElementFromParent)(this._accessibilityTreeRoot),this._rowElements.length=0;},t.prototype._onBoundaryFocus=function(e,t){var r=e.target,i=this._rowElements[0===t?1:this._rowElements.length-2];if(r.getAttribute("aria-posinset")!==(0===t?"1":""+this._terminal.buffer.lines.length)&&e.relatedTarget===i){var n,o;if(0===t?(n=r,o=this._rowElements.pop(),this._rowContainer.removeChild(o)):(n=this._rowElements.shift(),o=r,this._rowContainer.removeChild(n)),n.removeEventListener("focus",this._topBoundaryFocusListener),o.removeEventListener("focus",this._bottomBoundaryFocusListener),0===t){var s=this._createAccessibilityTreeNode();this._rowElements.unshift(s),this._rowContainer.insertAdjacentElement("afterbegin",s);}else s=this._createAccessibilityTreeNode(),this._rowElements.push(s),this._rowContainer.appendChild(s);this._rowElements[0].addEventListener("focus",this._topBoundaryFocusListener),this._rowElements[this._rowElements.length-1].addEventListener("focus",this._bottomBoundaryFocusListener),this._terminal.scrollLines(0===t?-1:1),this._rowElements[0===t?1:this._rowElements.length-2].focus(),e.preventDefault(),e.stopImmediatePropagation();}},t.prototype._onResize=function(e){this._rowElements[this._rowElements.length-1].removeEventListener("focus",this._bottomBoundaryFocusListener);for(var t=this._rowContainer.children.length;t<this._terminal.rows;t++)this._rowElements[t]=this._createAccessibilityTreeNode(),this._rowContainer.appendChild(this._rowElements[t]);for(;this._rowElements.length>e;)this._rowContainer.removeChild(this._rowElements.pop());this._rowElements[this._rowElements.length-1].addEventListener("focus",this._bottomBoundaryFocusListener),this._refreshRowsDimensions();},t.prototype._createAccessibilityTreeNode=function(){var e=document.createElement("div");return e.setAttribute("role","listitem"),e.tabIndex=-1,this._refreshRowDimensions(e),e},t.prototype._onTab=function(e){for(var t=0;t<e;t++)this._onChar(" ");},t.prototype._onChar=function(e){var t=this;this._liveRegionLineCount<21&&(this._charsToConsume.length>0?this._charsToConsume.shift()!==e&&(this._charsToAnnounce+=e):this._charsToAnnounce+=e,"\n"===e&&(this._liveRegionLineCount++,21===this._liveRegionLineCount&&(this._liveRegion.textContent+=o.tooMuchOutput)),s.isMac&&this._liveRegion.textContent&&this._liveRegion.textContent.length>0&&!this._liveRegion.parentNode&&setTimeout((function(){t._accessibilityTreeRoot.appendChild(t._liveRegion);}),0));},t.prototype._clearLiveRegion=function(){this._liveRegion.textContent="",this._liveRegionLineCount=0,s.isMac&&(0, u.removeElementFromParent)(this._liveRegion);},t.prototype._onKey=function(e){this._clearLiveRegion(),this._charsToConsume.push(e);},t.prototype._refreshRows=function(e,t){this._renderRowsDebouncer.refresh(e,t,this._terminal.rows);},t.prototype._renderRows=function(e,t){for(var r=this._terminal.buffer,i=r.lines.length.toString(),n=e;n<=t;n++){var o=r.translateBufferLineToString(r.ydisp+n,!0),s=(r.ydisp+n+1).toString(),a=this._rowElements[n];a&&(0===o.length?a.innerText=" ":a.textContent=o,a.setAttribute("aria-posinset",s),a.setAttribute("aria-setsize",i));}this._announceCharacters();},t.prototype._refreshRowsDimensions=function(){if(this._renderService.dimensions.actualCellHeight){this._rowElements.length!==this._terminal.rows&&this._onResize(this._terminal.rows);for(var e=0;e<this._terminal.rows;e++)this._refreshRowDimensions(this._rowElements[e]);}},t.prototype._refreshRowDimensions=function(e){e.style.height=this._renderService.dimensions.actualCellHeight+"px";},t.prototype._announceCharacters=function(){0!==this._charsToAnnounce.length&&(this._liveRegion.textContent+=this._charsToAnnounce,this._charsToAnnounce="");},t}(l.Disposable);t.AccessibilityManager=f;},3614:(e,t)=>{function r(e){return e.replace(/\r?\n/g,"\r")}function i(e,t){return t?"[200~"+e+"[201~":e}function n(e,t,n){e=i(e=r(e),n.decPrivateModes.bracketedPasteMode),n.triggerDataEvent(e,!0),t.value="";}function o(e,t,r){var i=r.getBoundingClientRect(),n=e.clientX-i.left-10,o=e.clientY-i.top-10;t.style.width="20px",t.style.height="20px",t.style.left=n+"px",t.style.top=o+"px",t.style.zIndex="1000",t.focus();}Object.defineProperty(t,"__esModule",{value:!0}),t.rightClickHandler=t.moveTextAreaUnderMouseCursor=t.paste=t.handlePasteEvent=t.copyHandler=t.bracketTextForPaste=t.prepareTextForTerminal=void 0,t.prepareTextForTerminal=r,t.bracketTextForPaste=i,t.copyHandler=function(e,t){e.clipboardData&&e.clipboardData.setData("text/plain",t.selectionText),e.preventDefault();},t.handlePasteEvent=function(e,t,r){e.stopPropagation(),e.clipboardData&&n(e.clipboardData.getData("text/plain"),t,r);},t.paste=n,t.moveTextAreaUnderMouseCursor=o,t.rightClickHandler=function(e,t,r,i,n){o(e,t,r),n&&i.rightClickSelect(e),t.value=i.selectionText,t.select();};},7239:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.ColorContrastCache=void 0;var r=function(){function e(){this._color={},this._rgba={};}return e.prototype.clear=function(){this._color={},this._rgba={};},e.prototype.setCss=function(e,t,r){this._rgba[e]||(this._rgba[e]={}),this._rgba[e][t]=r;},e.prototype.getCss=function(e,t){return this._rgba[e]?this._rgba[e][t]:void 0},e.prototype.setColor=function(e,t,r){this._color[e]||(this._color[e]={}),this._color[e][t]=r;},e.prototype.getColor=function(e,t){return this._color[e]?this._color[e][t]:void 0},e}();t.ColorContrastCache=r;},5680:function(e,t,r){var i=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s};Object.defineProperty(t,"__esModule",{value:!0}),t.ColorManager=t.DEFAULT_ANSI_COLORS=void 0;var n=r(8055),o=r(7239),s=n.css.toColor("#ffffff"),a=n.css.toColor("#000000"),c=n.css.toColor("#ffffff"),l=n.css.toColor("#000000"),h={css:"rgba(255, 255, 255, 0.3)",rgba:4294967117};t.DEFAULT_ANSI_COLORS=Object.freeze(function(){for(var e=[n.css.toColor("#2e3436"),n.css.toColor("#cc0000"),n.css.toColor("#4e9a06"),n.css.toColor("#c4a000"),n.css.toColor("#3465a4"),n.css.toColor("#75507b"),n.css.toColor("#06989a"),n.css.toColor("#d3d7cf"),n.css.toColor("#555753"),n.css.toColor("#ef2929"),n.css.toColor("#8ae234"),n.css.toColor("#fce94f"),n.css.toColor("#729fcf"),n.css.toColor("#ad7fa8"),n.css.toColor("#34e2e2"),n.css.toColor("#eeeeec")],t=[0,95,135,175,215,255],r=0;r<216;r++){var i=t[r/36%6|0],o=t[r/6%6|0],s=t[r%6];e.push({css:n.channels.toCss(i,o,s),rgba:n.channels.toRgba(i,o,s)});}for(r=0;r<24;r++){var a=8+10*r;e.push({css:n.channels.toCss(a,a,a),rgba:n.channels.toRgba(a,a,a)});}return e}());var u=function(){function e(e,r){this.allowTransparency=r;var i=e.createElement("canvas");i.width=1,i.height=1;var u=i.getContext("2d");if(!u)throw new Error("Could not get rendering context");this._ctx=u,this._ctx.globalCompositeOperation="copy",this._litmusColor=this._ctx.createLinearGradient(0,0,1,1),this._contrastCache=new o.ColorContrastCache,this.colors={foreground:s,background:a,cursor:c,cursorAccent:l,selectionTransparent:h,selectionOpaque:n.color.blend(a,h),selectionForeground:void 0,ansi:t.DEFAULT_ANSI_COLORS.slice(),contrastCache:this._contrastCache},this._updateRestoreColors();}return e.prototype.onOptionsChange=function(e){"minimumContrastRatio"===e&&this._contrastCache.clear();},e.prototype.setTheme=function(e){void 0===e&&(e={}),this.colors.foreground=this._parseColor(e.foreground,s),this.colors.background=this._parseColor(e.background,a),this.colors.cursor=this._parseColor(e.cursor,c,!0),this.colors.cursorAccent=this._parseColor(e.cursorAccent,l,!0),this.colors.selectionTransparent=this._parseColor(e.selection,h,!0),this.colors.selectionOpaque=n.color.blend(this.colors.background,this.colors.selectionTransparent);var r={css:"",rgba:0};this.colors.selectionForeground=e.selectionForeground?this._parseColor(e.selectionForeground,r):void 0,this.colors.selectionForeground===r&&(this.colors.selectionForeground=void 0),n.color.isOpaque(this.colors.selectionTransparent)&&(this.colors.selectionTransparent=n.color.opacity(this.colors.selectionTransparent,.3)),this.colors.ansi[0]=this._parseColor(e.black,t.DEFAULT_ANSI_COLORS[0]),this.colors.ansi[1]=this._parseColor(e.red,t.DEFAULT_ANSI_COLORS[1]),this.colors.ansi[2]=this._parseColor(e.green,t.DEFAULT_ANSI_COLORS[2]),this.colors.ansi[3]=this._parseColor(e.yellow,t.DEFAULT_ANSI_COLORS[3]),this.colors.ansi[4]=this._parseColor(e.blue,t.DEFAULT_ANSI_COLORS[4]),this.colors.ansi[5]=this._parseColor(e.magenta,t.DEFAULT_ANSI_COLORS[5]),this.colors.ansi[6]=this._parseColor(e.cyan,t.DEFAULT_ANSI_COLORS[6]),this.colors.ansi[7]=this._parseColor(e.white,t.DEFAULT_ANSI_COLORS[7]),this.colors.ansi[8]=this._parseColor(e.brightBlack,t.DEFAULT_ANSI_COLORS[8]),this.colors.ansi[9]=this._parseColor(e.brightRed,t.DEFAULT_ANSI_COLORS[9]),this.colors.ansi[10]=this._parseColor(e.brightGreen,t.DEFAULT_ANSI_COLORS[10]),this.colors.ansi[11]=this._parseColor(e.brightYellow,t.DEFAULT_ANSI_COLORS[11]),this.colors.ansi[12]=this._parseColor(e.brightBlue,t.DEFAULT_ANSI_COLORS[12]),this.colors.ansi[13]=this._parseColor(e.brightMagenta,t.DEFAULT_ANSI_COLORS[13]),this.colors.ansi[14]=this._parseColor(e.brightCyan,t.DEFAULT_ANSI_COLORS[14]),this.colors.ansi[15]=this._parseColor(e.brightWhite,t.DEFAULT_ANSI_COLORS[15]),this._contrastCache.clear(),this._updateRestoreColors();},e.prototype.restoreColor=function(e){if(void 0!==e)switch(e){case 256:this.colors.foreground=this._restoreColors.foreground;break;case 257:this.colors.background=this._restoreColors.background;break;case 258:this.colors.cursor=this._restoreColors.cursor;break;default:this.colors.ansi[e]=this._restoreColors.ansi[e];}else for(var t=0;t<this._restoreColors.ansi.length;++t)this.colors.ansi[t]=this._restoreColors.ansi[t];},e.prototype._updateRestoreColors=function(){this._restoreColors={foreground:this.colors.foreground,background:this.colors.background,cursor:this.colors.cursor,ansi:this.colors.ansi.slice()};},e.prototype._parseColor=function(e,t,r){if(void 0===r&&(r=this.allowTransparency),void 0===e)return t;if(this._ctx.fillStyle=this._litmusColor,this._ctx.fillStyle=e,"string"!=typeof this._ctx.fillStyle)return console.warn("Color: "+e+" is invalid using fallback "+t.css),t;this._ctx.fillRect(0,0,1,1);var o=this._ctx.getImageData(0,0,1,1).data;if(255!==o[3]){if(!r)return console.warn("Color: "+e+" is using transparency, but allowTransparency is false. Using fallback "+t.css+"."),t;var s=i(this._ctx.fillStyle.substring(5,this._ctx.fillStyle.length-1).split(",").map((function(e){return Number(e)})),4),a=s[0],c=s[1],l=s[2],h=s[3],u=Math.round(255*h);return {rgba:n.channels.toRgba(a,c,l,u),css:e}}return {css:this._ctx.fillStyle,rgba:n.channels.toRgba(o[0],o[1],o[2],o[3])}},e}();t.ColorManager=u;},9631:function(e,t){var r=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.removeElementFromParent=void 0,t.removeElementFromParent=function(){for(var e,t,i,n=[],o=0;o<arguments.length;o++)n[o]=arguments[o];try{for(var s=r(n),a=s.next();!a.done;a=s.next()){var c=a.value;null===(i=null==c?void 0:c.parentElement)||void 0===i||i.removeChild(c);}}catch(t){e={error:t};}finally{try{a&&!a.done&&(t=s.return)&&t.call(s);}finally{if(e)throw e.error}}};},3656:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.addDisposableDomListener=void 0,t.addDisposableDomListener=function(e,t,r,i){e.addEventListener(t,r,i);var n=!1;return {dispose:function(){n||(n=!0,e.removeEventListener(t,r,i));}}};},3551:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.MouseZone=t.Linkifier=void 0;var o=r(8460),s=r(2585),a=function(){function e(e,t,r){this._bufferService=e,this._logService=t,this._unicodeService=r,this._linkMatchers=[],this._nextLinkMatcherId=0,this._onShowLinkUnderline=new o.EventEmitter,this._onHideLinkUnderline=new o.EventEmitter,this._onLinkTooltip=new o.EventEmitter,this._rowsToLinkify={start:void 0,end:void 0};}return Object.defineProperty(e.prototype,"onShowLinkUnderline",{get:function(){return this._onShowLinkUnderline.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onHideLinkUnderline",{get:function(){return this._onHideLinkUnderline.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onLinkTooltip",{get:function(){return this._onLinkTooltip.event},enumerable:!1,configurable:!0}),e.prototype.attachToDom=function(e,t){this._element=e,this._mouseZoneManager=t;},e.prototype.linkifyRows=function(t,r){var i=this;this._mouseZoneManager&&(void 0===this._rowsToLinkify.start||void 0===this._rowsToLinkify.end?(this._rowsToLinkify.start=t,this._rowsToLinkify.end=r):(this._rowsToLinkify.start=Math.min(this._rowsToLinkify.start,t),this._rowsToLinkify.end=Math.max(this._rowsToLinkify.end,r)),this._mouseZoneManager.clearAll(t,r),this._rowsTimeoutId&&clearTimeout(this._rowsTimeoutId),this._rowsTimeoutId=setTimeout((function(){return i._linkifyRows()}),e._timeBeforeLatency));},e.prototype._linkifyRows=function(){this._rowsTimeoutId=void 0;var e=this._bufferService.buffer;if(void 0!==this._rowsToLinkify.start&&void 0!==this._rowsToLinkify.end){var t=e.ydisp+this._rowsToLinkify.start;if(!(t>=e.lines.length)){for(var r=e.ydisp+Math.min(this._rowsToLinkify.end,this._bufferService.rows)+1,i=Math.ceil(2e3/this._bufferService.cols),n=this._bufferService.buffer.iterator(!1,t,r,i,i);n.hasNext();)for(var o=n.next(),s=0;s<this._linkMatchers.length;s++)this._doLinkifyRow(o.range.first,o.content,this._linkMatchers[s]);this._rowsToLinkify.start=void 0,this._rowsToLinkify.end=void 0;}}else this._logService.debug("_rowToLinkify was unset before _linkifyRows was called");},e.prototype.registerLinkMatcher=function(e,t,r){if(void 0===r&&(r={}),!t)throw new Error("handler must be defined");var i={id:this._nextLinkMatcherId++,regex:e,handler:t,matchIndex:r.matchIndex,validationCallback:r.validationCallback,hoverTooltipCallback:r.tooltipCallback,hoverLeaveCallback:r.leaveCallback,willLinkActivate:r.willLinkActivate,priority:r.priority||0};return this._addLinkMatcherToList(i),i.id},e.prototype._addLinkMatcherToList=function(e){if(0!==this._linkMatchers.length){for(var t=this._linkMatchers.length-1;t>=0;t--)if(e.priority<=this._linkMatchers[t].priority)return void this._linkMatchers.splice(t+1,0,e);this._linkMatchers.splice(0,0,e);}else this._linkMatchers.push(e);},e.prototype.deregisterLinkMatcher=function(e){for(var t=0;t<this._linkMatchers.length;t++)if(this._linkMatchers[t].id===e)return this._linkMatchers.splice(t,1),!0;return !1},e.prototype._doLinkifyRow=function(e,t,r){for(var i,n=this,o=new RegExp(r.regex.source,(r.regex.flags||"")+"g"),s=-1,a=function(){var a=i["number"!=typeof r.matchIndex?0:r.matchIndex];if(!a)return c._logService.debug("match found without corresponding matchIndex",i,r),"break";if(s=t.indexOf(a,s+1),o.lastIndex=s+a.length,s<0)return "break";var l=c._bufferService.buffer.stringIndexToBufferIndex(e,s);if(l[0]<0)return "break";var h=c._bufferService.buffer.lines.get(l[0]);if(!h)return "break";var u=h.getFg(l[1]),f=u?u>>9&511:void 0;r.validationCallback?r.validationCallback(a,(function(e){n._rowsTimeoutId||e&&n._addLink(l[1],l[0]-n._bufferService.buffer.ydisp,a,r,f);})):c._addLink(l[1],l[0]-c._bufferService.buffer.ydisp,a,r,f);},c=this;null!==(i=o.exec(t))&&"break"!==a(););},e.prototype._addLink=function(e,t,r,i,n){var o=this;if(this._mouseZoneManager&&this._element){var s=this._unicodeService.getStringCellWidth(r),a=e%this._bufferService.cols,l=t+Math.floor(e/this._bufferService.cols),h=(a+s)%this._bufferService.cols,u=l+Math.floor((a+s)/this._bufferService.cols);0===h&&(h=this._bufferService.cols,u--),this._mouseZoneManager.add(new c(a+1,l+1,h+1,u+1,(function(e){if(i.handler)return i.handler(e,r);var t=window.open();t?(t.opener=null,t.location.href=r):console.warn("Opening link blocked as opener could not be cleared");}),(function(){o._onShowLinkUnderline.fire(o._createLinkHoverEvent(a,l,h,u,n)),o._element.classList.add("xterm-cursor-pointer");}),(function(e){o._onLinkTooltip.fire(o._createLinkHoverEvent(a,l,h,u,n)),i.hoverTooltipCallback&&i.hoverTooltipCallback(e,r,{start:{x:a,y:l},end:{x:h,y:u}});}),(function(){o._onHideLinkUnderline.fire(o._createLinkHoverEvent(a,l,h,u,n)),o._element.classList.remove("xterm-cursor-pointer"),i.hoverLeaveCallback&&i.hoverLeaveCallback();}),(function(e){return !i.willLinkActivate||i.willLinkActivate(e,r)})));}},e.prototype._createLinkHoverEvent=function(e,t,r,i,n){return {x1:e,y1:t,x2:r,y2:i,cols:this._bufferService.cols,fg:n}},e._timeBeforeLatency=200,e=i([n(0,s.IBufferService),n(1,s.ILogService),n(2,s.IUnicodeService)],e)}();t.Linkifier=a;var c=function(e,t,r,i,n,o,s,a,c){this.x1=e,this.y1=t,this.x2=r,this.y2=i,this.clickCallback=n,this.hoverCallback=o,this.tooltipCallback=s,this.leaveCallback=a,this.willLinkActivate=c;};t.MouseZone=c;},6465:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},a=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")},c=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s};Object.defineProperty(t,"__esModule",{value:!0}),t.Linkifier2=void 0;var l=r(2585),h=r(8460),u=r(844),f=r(3656),_=function(e){function t(t){var r=e.call(this)||this;return r._bufferService=t,r._linkProviders=[],r._linkCacheDisposables=[],r._isMouseOut=!0,r._activeLine=-1,r._onShowLinkUnderline=r.register(new h.EventEmitter),r._onHideLinkUnderline=r.register(new h.EventEmitter),r.register((0, u.getDisposeArrayDisposable)(r._linkCacheDisposables)),r}return n(t,e),Object.defineProperty(t.prototype,"currentLink",{get:function(){return this._currentLink},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onShowLinkUnderline",{get:function(){return this._onShowLinkUnderline.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onHideLinkUnderline",{get:function(){return this._onHideLinkUnderline.event},enumerable:!1,configurable:!0}),t.prototype.registerLinkProvider=function(e){var t=this;return this._linkProviders.push(e),{dispose:function(){var r=t._linkProviders.indexOf(e);-1!==r&&t._linkProviders.splice(r,1);}}},t.prototype.attachToDom=function(e,t,r){var i=this;this._element=e,this._mouseService=t,this._renderService=r,this.register((0, f.addDisposableDomListener)(this._element,"mouseleave",(function(){i._isMouseOut=!0,i._clearCurrentLink();}))),this.register((0, f.addDisposableDomListener)(this._element,"mousemove",this._onMouseMove.bind(this))),this.register((0, f.addDisposableDomListener)(this._element,"mousedown",this._handleMouseDown.bind(this))),this.register((0, f.addDisposableDomListener)(this._element,"mouseup",this._handleMouseUp.bind(this)));},t.prototype._onMouseMove=function(e){if(this._lastMouseEvent=e,this._element&&this._mouseService){var t=this._positionFromMouseEvent(e,this._element,this._mouseService);if(t){this._isMouseOut=!1;for(var r=e.composedPath(),i=0;i<r.length;i++){var n=r[i];if(n.classList.contains("xterm"))break;if(n.classList.contains("xterm-hover"))return}this._lastBufferCell&&t.x===this._lastBufferCell.x&&t.y===this._lastBufferCell.y||(this._onHover(t),this._lastBufferCell=t);}}},t.prototype._onHover=function(e){if(this._activeLine!==e.y)return this._clearCurrentLink(),void this._askForLink(e,!1);this._currentLink&&this._linkAtPosition(this._currentLink.link,e)||(this._clearCurrentLink(),this._askForLink(e,!0));},t.prototype._askForLink=function(e,t){var r,i,n,o,s=this;this._activeProviderReplies&&t||(null===(n=this._activeProviderReplies)||void 0===n||n.forEach((function(e){null==e||e.forEach((function(e){e.link.dispose&&e.link.dispose();}));})),this._activeProviderReplies=new Map,this._activeLine=e.y);var l=!1,h=function(r,i){t?(null===(o=u._activeProviderReplies)||void 0===o?void 0:o.get(r))&&(l=u._checkLinkProviderResult(r,e,l)):i.provideLinks(e.y,(function(t){var i,n;if(!s._isMouseOut){var o=null==t?void 0:t.map((function(e){return {link:e}}));null===(i=s._activeProviderReplies)||void 0===i||i.set(r,o),l=s._checkLinkProviderResult(r,e,l),(null===(n=s._activeProviderReplies)||void 0===n?void 0:n.size)===s._linkProviders.length&&s._removeIntersectingLinks(e.y,s._activeProviderReplies);}}));},u=this;try{for(var f=a(this._linkProviders.entries()),_=f.next();!_.done;_=f.next()){var d=c(_.value,2);h(d[0],d[1]);}}catch(e){r={error:e};}finally{try{_&&!_.done&&(i=f.return)&&i.call(f);}finally{if(r)throw r.error}}},t.prototype._removeIntersectingLinks=function(e,t){for(var r=new Set,i=0;i<t.size;i++){var n=t.get(i);if(n)for(var o=0;o<n.length;o++)for(var s=n[o],a=s.link.range.start.y<e?0:s.link.range.start.x,c=s.link.range.end.y>e?this._bufferService.cols:s.link.range.end.x,l=a;l<=c;l++){if(r.has(l)){n.splice(o--,1);break}r.add(l);}}},t.prototype._checkLinkProviderResult=function(e,t,r){var i,n=this;if(!this._activeProviderReplies)return r;for(var o=this._activeProviderReplies.get(e),s=!1,a=0;a<e;a++)this._activeProviderReplies.has(a)&&!this._activeProviderReplies.get(a)||(s=!0);if(!s&&o){var c=o.find((function(e){return n._linkAtPosition(e.link,t)}));c&&(r=!0,this._handleNewLink(c));}if(this._activeProviderReplies.size===this._linkProviders.length&&!r)for(a=0;a<this._activeProviderReplies.size;a++){var l=null===(i=this._activeProviderReplies.get(a))||void 0===i?void 0:i.find((function(e){return n._linkAtPosition(e.link,t)}));if(l){r=!0,this._handleNewLink(l);break}}return r},t.prototype._handleMouseDown=function(){this._mouseDownLink=this._currentLink;},t.prototype._handleMouseUp=function(e){if(this._element&&this._mouseService&&this._currentLink){var t=this._positionFromMouseEvent(e,this._element,this._mouseService);t&&this._mouseDownLink===this._currentLink&&this._linkAtPosition(this._currentLink.link,t)&&this._currentLink.link.activate(e,this._currentLink.link.text);}},t.prototype._clearCurrentLink=function(e,t){this._element&&this._currentLink&&this._lastMouseEvent&&(!e||!t||this._currentLink.link.range.start.y>=e&&this._currentLink.link.range.end.y<=t)&&(this._linkLeave(this._element,this._currentLink.link,this._lastMouseEvent),this._currentLink=void 0,(0, u.disposeArray)(this._linkCacheDisposables));},t.prototype._handleNewLink=function(e){var t=this;if(this._element&&this._lastMouseEvent&&this._mouseService){var r=this._positionFromMouseEvent(this._lastMouseEvent,this._element,this._mouseService);r&&this._linkAtPosition(e.link,r)&&(this._currentLink=e,this._currentLink.state={decorations:{underline:void 0===e.link.decorations||e.link.decorations.underline,pointerCursor:void 0===e.link.decorations||e.link.decorations.pointerCursor},isHovered:!0},this._linkHover(this._element,e.link,this._lastMouseEvent),e.link.decorations={},Object.defineProperties(e.link.decorations,{pointerCursor:{get:function(){var e,r;return null===(r=null===(e=t._currentLink)||void 0===e?void 0:e.state)||void 0===r?void 0:r.decorations.pointerCursor},set:function(e){var r,i;(null===(r=t._currentLink)||void 0===r?void 0:r.state)&&t._currentLink.state.decorations.pointerCursor!==e&&(t._currentLink.state.decorations.pointerCursor=e,t._currentLink.state.isHovered&&(null===(i=t._element)||void 0===i||i.classList.toggle("xterm-cursor-pointer",e)));}},underline:{get:function(){var e,r;return null===(r=null===(e=t._currentLink)||void 0===e?void 0:e.state)||void 0===r?void 0:r.decorations.underline},set:function(r){var i,n,o;(null===(i=t._currentLink)||void 0===i?void 0:i.state)&&(null===(o=null===(n=t._currentLink)||void 0===n?void 0:n.state)||void 0===o?void 0:o.decorations.underline)!==r&&(t._currentLink.state.decorations.underline=r,t._currentLink.state.isHovered&&t._fireUnderlineEvent(e.link,r));}}}),this._renderService&&this._linkCacheDisposables.push(this._renderService.onRenderedViewportChange((function(e){var r=0===e.start?0:e.start+1+t._bufferService.buffer.ydisp;t._clearCurrentLink(r,e.end+1+t._bufferService.buffer.ydisp);}))));}},t.prototype._linkHover=function(e,t,r){var i;(null===(i=this._currentLink)||void 0===i?void 0:i.state)&&(this._currentLink.state.isHovered=!0,this._currentLink.state.decorations.underline&&this._fireUnderlineEvent(t,!0),this._currentLink.state.decorations.pointerCursor&&e.classList.add("xterm-cursor-pointer")),t.hover&&t.hover(r,t.text);},t.prototype._fireUnderlineEvent=function(e,t){var r=e.range,i=this._bufferService.buffer.ydisp,n=this._createLinkUnderlineEvent(r.start.x-1,r.start.y-i-1,r.end.x,r.end.y-i-1,void 0);(t?this._onShowLinkUnderline:this._onHideLinkUnderline).fire(n);},t.prototype._linkLeave=function(e,t,r){var i;(null===(i=this._currentLink)||void 0===i?void 0:i.state)&&(this._currentLink.state.isHovered=!1,this._currentLink.state.decorations.underline&&this._fireUnderlineEvent(t,!1),this._currentLink.state.decorations.pointerCursor&&e.classList.remove("xterm-cursor-pointer")),t.leave&&t.leave(r,t.text);},t.prototype._linkAtPosition=function(e,t){var r=e.range.start.y===e.range.end.y,i=e.range.start.y<t.y,n=e.range.end.y>t.y;return (r&&e.range.start.x<=t.x&&e.range.end.x>=t.x||i&&e.range.end.x>=t.x||n&&e.range.start.x<=t.x||i&&n)&&e.range.start.y<=t.y&&e.range.end.y>=t.y},t.prototype._positionFromMouseEvent=function(e,t,r){var i=r.getCoords(e,t,this._bufferService.cols,this._bufferService.rows);if(i)return {x:i[0],y:i[1]+this._bufferService.buffer.ydisp}},t.prototype._createLinkUnderlineEvent=function(e,t,r,i,n){return {x1:e,y1:t,x2:r,y2:i,cols:this._bufferService.cols,fg:n}},o([s(0,l.IBufferService)],t)}(u.Disposable);t.Linkifier2=_;},9042:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.tooMuchOutput=t.promptLabel=void 0,t.promptLabel="Terminal input",t.tooMuchOutput="Too much output to announce, navigate to rows manually to read";},6954:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.MouseZoneManager=void 0;var a=r(844),c=r(3656),l=r(4725),h=r(2585),u=function(e){function t(t,r,i,n,o,s){var a=e.call(this)||this;return a._element=t,a._screenElement=r,a._bufferService=i,a._mouseService=n,a._selectionService=o,a._optionsService=s,a._zones=[],a._areZonesActive=!1,a._lastHoverCoords=[void 0,void 0],a._initialSelectionLength=0,a.register((0, c.addDisposableDomListener)(a._element,"mousedown",(function(e){return a._onMouseDown(e)}))),a._mouseMoveListener=function(e){return a._onMouseMove(e)},a._mouseLeaveListener=function(e){return a._onMouseLeave(e)},a._clickListener=function(e){return a._onClick(e)},a}return n(t,e),t.prototype.dispose=function(){e.prototype.dispose.call(this),this._deactivate();},t.prototype.add=function(e){this._zones.push(e),1===this._zones.length&&this._activate();},t.prototype.clearAll=function(e,t){if(0!==this._zones.length){e&&t||(e=0,t=this._bufferService.rows-1);for(var r=0;r<this._zones.length;r++){var i=this._zones[r];(i.y1>e&&i.y1<=t+1||i.y2>e&&i.y2<=t+1||i.y1<e&&i.y2>t+1)&&(this._currentZone&&this._currentZone===i&&(this._currentZone.leaveCallback(),this._currentZone=void 0),this._zones.splice(r--,1));}0===this._zones.length&&this._deactivate();}},t.prototype._activate=function(){this._areZonesActive||(this._areZonesActive=!0,this._element.addEventListener("mousemove",this._mouseMoveListener),this._element.addEventListener("mouseleave",this._mouseLeaveListener),this._element.addEventListener("click",this._clickListener));},t.prototype._deactivate=function(){this._areZonesActive&&(this._areZonesActive=!1,this._element.removeEventListener("mousemove",this._mouseMoveListener),this._element.removeEventListener("mouseleave",this._mouseLeaveListener),this._element.removeEventListener("click",this._clickListener));},t.prototype._onMouseMove=function(e){this._lastHoverCoords[0]===e.pageX&&this._lastHoverCoords[1]===e.pageY||(this._onHover(e),this._lastHoverCoords=[e.pageX,e.pageY]);},t.prototype._onHover=function(e){var t=this,r=this._findZoneEventAt(e);r!==this._currentZone&&(this._currentZone&&(this._currentZone.leaveCallback(),this._currentZone=void 0,this._tooltipTimeout&&clearTimeout(this._tooltipTimeout)),r&&(this._currentZone=r,r.hoverCallback&&r.hoverCallback(e),this._tooltipTimeout=window.setTimeout((function(){return t._onTooltip(e)}),this._optionsService.rawOptions.linkTooltipHoverDuration)));},t.prototype._onTooltip=function(e){this._tooltipTimeout=void 0;var t=this._findZoneEventAt(e);null==t||t.tooltipCallback(e);},t.prototype._onMouseDown=function(e){if(this._initialSelectionLength=this._getSelectionLength(),this._areZonesActive){var t=this._findZoneEventAt(e);(null==t?void 0:t.willLinkActivate(e))&&(e.preventDefault(),e.stopImmediatePropagation());}},t.prototype._onMouseLeave=function(e){this._currentZone&&(this._currentZone.leaveCallback(),this._currentZone=void 0,this._tooltipTimeout&&clearTimeout(this._tooltipTimeout));},t.prototype._onClick=function(e){var t=this._findZoneEventAt(e),r=this._getSelectionLength();t&&r===this._initialSelectionLength&&(t.clickCallback(e),e.preventDefault(),e.stopImmediatePropagation());},t.prototype._getSelectionLength=function(){var e=this._selectionService.selectionText;return e?e.length:0},t.prototype._findZoneEventAt=function(e){var t=this._mouseService.getCoords(e,this._screenElement,this._bufferService.cols,this._bufferService.rows);if(t)for(var r=t[0],i=t[1],n=0;n<this._zones.length;n++){var o=this._zones[n];if(o.y1===o.y2){if(i===o.y1&&r>=o.x1&&r<o.x2)return o}else if(i===o.y1&&r>=o.x1||i===o.y2&&r<o.x2||i>o.y1&&i<o.y2)return o}},o([s(2,h.IBufferService),s(3,l.IMouseService),s(4,l.ISelectionService),s(5,h.IOptionsService)],t)}(a.Disposable);t.MouseZoneManager=u;},6193:function(e,t){var r=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.RenderDebouncer=void 0;var i=function(){function e(e){this._renderCallback=e,this._refreshCallbacks=[];}return e.prototype.dispose=function(){this._animationFrame&&(window.cancelAnimationFrame(this._animationFrame),this._animationFrame=void 0);},e.prototype.addRefreshCallback=function(e){var t=this;return this._refreshCallbacks.push(e),this._animationFrame||(this._animationFrame=window.requestAnimationFrame((function(){return t._innerRefresh()}))),this._animationFrame},e.prototype.refresh=function(e,t,r){var i=this;this._rowCount=r,e=void 0!==e?e:0,t=void 0!==t?t:this._rowCount-1,this._rowStart=void 0!==this._rowStart?Math.min(this._rowStart,e):e,this._rowEnd=void 0!==this._rowEnd?Math.max(this._rowEnd,t):t,this._animationFrame||(this._animationFrame=window.requestAnimationFrame((function(){return i._innerRefresh()})));},e.prototype._innerRefresh=function(){if(this._animationFrame=void 0,void 0!==this._rowStart&&void 0!==this._rowEnd&&void 0!==this._rowCount){var e=Math.max(this._rowStart,0),t=Math.min(this._rowEnd,this._rowCount-1);this._rowStart=void 0,this._rowEnd=void 0,this._renderCallback(e,t),this._runRefreshCallbacks();}else this._runRefreshCallbacks();},e.prototype._runRefreshCallbacks=function(){var e,t;try{for(var i=r(this._refreshCallbacks),n=i.next();!n.done;n=i.next())(0,n.value)(0);}catch(t){e={error:t};}finally{try{n&&!n.done&&(t=i.return)&&t.call(i);}finally{if(e)throw e.error}}this._refreshCallbacks=[];},e}();t.RenderDebouncer=i;},5596:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.ScreenDprMonitor=void 0;var o=function(e){function t(){var t=null!==e&&e.apply(this,arguments)||this;return t._currentDevicePixelRatio=window.devicePixelRatio,t}return n(t,e),t.prototype.setListener=function(e){var t=this;this._listener&&this.clearListener(),this._listener=e,this._outerListener=function(){t._listener&&(t._listener(window.devicePixelRatio,t._currentDevicePixelRatio),t._updateDpr());},this._updateDpr();},t.prototype.dispose=function(){e.prototype.dispose.call(this),this.clearListener();},t.prototype._updateDpr=function(){var e;this._outerListener&&(null===(e=this._resolutionMediaMatchList)||void 0===e||e.removeListener(this._outerListener),this._currentDevicePixelRatio=window.devicePixelRatio,this._resolutionMediaMatchList=window.matchMedia("screen and (resolution: "+window.devicePixelRatio+"dppx)"),this._resolutionMediaMatchList.addListener(this._outerListener));},t.prototype.clearListener=function(){this._resolutionMediaMatchList&&this._listener&&this._outerListener&&(this._resolutionMediaMatchList.removeListener(this._outerListener),this._resolutionMediaMatchList=void 0,this._listener=void 0,this._outerListener=void 0);},t}(r(844).Disposable);t.ScreenDprMonitor=o;},3236:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")},s=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s},a=this&&this.__spreadArray||function(e,t,r){if(r||2===arguments.length)for(var i,n=0,o=t.length;n<o;n++)!i&&n in t||(i||(i=Array.prototype.slice.call(t,0,n)),i[n]=t[n]);return e.concat(i||Array.prototype.slice.call(t))};Object.defineProperty(t,"__esModule",{value:!0}),t.Terminal=void 0;var c=r(2950),l=r(1680),h=r(3614),u=r(2584),f=r(5435),_=r(3525),d=r(3551),p=r(9312),v=r(6114),y=r(3656),g=r(9042),m=r(357),b=r(6954),S=r(4567),C=r(1296),w=r(7399),L=r(8460),E=r(8437),x=r(5680),R=r(3230),k=r(4725),M=r(428),A=r(8934),O=r(6465),D=r(5114),T=r(8969),B=r(8055),P=r(4269),I=r(5941),H=r(3107),j=r(5744),F=r(9074),W=r(2585),U="undefined"!=typeof window?window.document:null,q=function(e){function t(t){void 0===t&&(t={});var r=e.call(this,t)||this;return r.browser=v,r._keyDownHandled=!1,r._keyDownSeen=!1,r._keyPressHandled=!1,r._unprocessedDeadKey=!1,r._onCursorMove=new L.EventEmitter,r._onKey=new L.EventEmitter,r._onRender=new L.EventEmitter,r._onSelectionChange=new L.EventEmitter,r._onTitleChange=new L.EventEmitter,r._onBell=new L.EventEmitter,r._onFocus=new L.EventEmitter,r._onBlur=new L.EventEmitter,r._onA11yCharEmitter=new L.EventEmitter,r._onA11yTabEmitter=new L.EventEmitter,r._setup(),r.linkifier=r._instantiationService.createInstance(d.Linkifier),r.linkifier2=r.register(r._instantiationService.createInstance(O.Linkifier2)),r._decorationService=r._instantiationService.createInstance(F.DecorationService),r._instantiationService.setService(W.IDecorationService,r._decorationService),r.register(r._inputHandler.onRequestBell((function(){return r.bell()}))),r.register(r._inputHandler.onRequestRefreshRows((function(e,t){return r.refresh(e,t)}))),r.register(r._inputHandler.onRequestSendFocus((function(){return r._reportFocus()}))),r.register(r._inputHandler.onRequestReset((function(){return r.reset()}))),r.register(r._inputHandler.onRequestWindowsOptionsReport((function(e){return r._reportWindowsOptions(e)}))),r.register(r._inputHandler.onColor((function(e){return r._handleColorEvent(e)}))),r.register((0, L.forwardEvent)(r._inputHandler.onCursorMove,r._onCursorMove)),r.register((0, L.forwardEvent)(r._inputHandler.onTitleChange,r._onTitleChange)),r.register((0, L.forwardEvent)(r._inputHandler.onA11yChar,r._onA11yCharEmitter)),r.register((0, L.forwardEvent)(r._inputHandler.onA11yTab,r._onA11yTabEmitter)),r.register(r._bufferService.onResize((function(e){return r._afterResize(e.cols,e.rows)}))),r}return n(t,e),Object.defineProperty(t.prototype,"onCursorMove",{get:function(){return this._onCursorMove.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onKey",{get:function(){return this._onKey.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRender",{get:function(){return this._onRender.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onSelectionChange",{get:function(){return this._onSelectionChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onTitleChange",{get:function(){return this._onTitleChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onBell",{get:function(){return this._onBell.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onFocus",{get:function(){return this._onFocus.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onBlur",{get:function(){return this._onBlur.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onA11yChar",{get:function(){return this._onA11yCharEmitter.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onA11yTab",{get:function(){return this._onA11yTabEmitter.event},enumerable:!1,configurable:!0}),t.prototype._handleColorEvent=function(e){var t,r,i,n;if(this._colorManager){try{for(var c=o(e),l=c.next();!l.done;l=c.next()){var h=l.value,f=void 0,_="";switch(h.index){case 256:f="foreground",_="10";break;case 257:f="background",_="11";break;case 258:f="cursor",_="12";break;default:f="ansi",_="4;"+h.index;}if(f)switch(h.type){case 0:var d=B.color.toColorRGB("ansi"===f?this._colorManager.colors.ansi[h.index]:this._colorManager.colors[f]);this.coreService.triggerDataEvent(u.C0.ESC+"]"+_+";"+(0,I.toRgbString)(d)+u.C1_ESCAPED.ST);break;case 1:"ansi"===f?this._colorManager.colors.ansi[h.index]=B.rgba.toColor.apply(B.rgba,a([],s(h.color),!1)):this._colorManager.colors[f]=B.rgba.toColor.apply(B.rgba,a([],s(h.color),!1));break;case 2:this._colorManager.restoreColor(h.index);}}}catch(e){t={error:e};}finally{try{l&&!l.done&&(r=c.return)&&r.call(c);}finally{if(t)throw t.error}}null===(i=this._renderService)||void 0===i||i.setColors(this._colorManager.colors),null===(n=this.viewport)||void 0===n||n.onThemeChange(this._colorManager.colors);}},t.prototype.dispose=function(){var t,r,i;this._isDisposed||(e.prototype.dispose.call(this),null===(t=this._renderService)||void 0===t||t.dispose(),this._customKeyEventHandler=void 0,this.write=function(){},null===(i=null===(r=this.element)||void 0===r?void 0:r.parentNode)||void 0===i||i.removeChild(this.element));},t.prototype._setup=function(){e.prototype._setup.call(this),this._customKeyEventHandler=void 0;},Object.defineProperty(t.prototype,"buffer",{get:function(){return this.buffers.active},enumerable:!1,configurable:!0}),t.prototype.focus=function(){this.textarea&&this.textarea.focus({preventScroll:!0});},t.prototype._updateOptions=function(t){var r,i,n,o;switch(e.prototype._updateOptions.call(this,t),t){case"fontFamily":case"fontSize":null===(r=this._renderService)||void 0===r||r.clear(),null===(i=this._charSizeService)||void 0===i||i.measure();break;case"cursorBlink":case"cursorStyle":this.refresh(this.buffer.y,this.buffer.y);break;case"customGlyphs":case"drawBoldTextInBrightColors":case"letterSpacing":case"lineHeight":case"fontWeight":case"fontWeightBold":case"minimumContrastRatio":this._renderService&&(this._renderService.clear(),this._renderService.onResize(this.cols,this.rows),this.refresh(0,this.rows-1));break;case"rendererType":this._renderService&&(this._renderService.setRenderer(this._createRenderer()),this._renderService.onResize(this.cols,this.rows));break;case"scrollback":null===(n=this.viewport)||void 0===n||n.syncScrollArea();break;case"screenReaderMode":this.optionsService.rawOptions.screenReaderMode?!this._accessibilityManager&&this._renderService&&(this._accessibilityManager=new S.AccessibilityManager(this,this._renderService)):(null===(o=this._accessibilityManager)||void 0===o||o.dispose(),this._accessibilityManager=void 0);break;case"tabStopWidth":this.buffers.setupTabStops();break;case"theme":this._setTheme(this.optionsService.rawOptions.theme);}},t.prototype._onTextAreaFocus=function(e){this.coreService.decPrivateModes.sendFocus&&this.coreService.triggerDataEvent(u.C0.ESC+"[I"),this.updateCursorStyle(e),this.element.classList.add("focus"),this._showCursor(),this._onFocus.fire();},t.prototype.blur=function(){var e;return null===(e=this.textarea)||void 0===e?void 0:e.blur()},t.prototype._onTextAreaBlur=function(){this.textarea.value="",this.refresh(this.buffer.y,this.buffer.y),this.coreService.decPrivateModes.sendFocus&&this.coreService.triggerDataEvent(u.C0.ESC+"[O"),this.element.classList.remove("focus"),this._onBlur.fire();},t.prototype._syncTextArea=function(){if(this.textarea&&this.buffer.isCursorInViewport&&!this._compositionHelper.isComposing&&this._renderService){var e=this.buffer.ybase+this.buffer.y,t=this.buffer.lines.get(e);if(t){var r=Math.min(this.buffer.x,this.cols-1),i=this._renderService.dimensions.actualCellHeight,n=t.getWidth(r),o=this._renderService.dimensions.actualCellWidth*n,s=this.buffer.y*this._renderService.dimensions.actualCellHeight,a=r*this._renderService.dimensions.actualCellWidth;this.textarea.style.left=a+"px",this.textarea.style.top=s+"px",this.textarea.style.width=o+"px",this.textarea.style.height=i+"px",this.textarea.style.lineHeight=i+"px",this.textarea.style.zIndex="-5";}}},t.prototype._initGlobal=function(){var e=this;this._bindKeys(),this.register((0, y.addDisposableDomListener)(this.element,"copy",(function(t){e.hasSelection()&&(0, h.copyHandler)(t,e._selectionService);})));var t=function(t){return (0, h.handlePasteEvent)(t,e.textarea,e.coreService)};this.register((0, y.addDisposableDomListener)(this.textarea,"paste",t)),this.register((0, y.addDisposableDomListener)(this.element,"paste",t)),v.isFirefox?this.register((0, y.addDisposableDomListener)(this.element,"mousedown",(function(t){2===t.button&&(0, h.rightClickHandler)(t,e.textarea,e.screenElement,e._selectionService,e.options.rightClickSelectsWord);}))):this.register((0, y.addDisposableDomListener)(this.element,"contextmenu",(function(t){(0, h.rightClickHandler)(t,e.textarea,e.screenElement,e._selectionService,e.options.rightClickSelectsWord);}))),v.isLinux&&this.register((0, y.addDisposableDomListener)(this.element,"auxclick",(function(t){1===t.button&&(0, h.moveTextAreaUnderMouseCursor)(t,e.textarea,e.screenElement);})));},t.prototype._bindKeys=function(){var e=this;this.register((0, y.addDisposableDomListener)(this.textarea,"keyup",(function(t){return e._keyUp(t)}),!0)),this.register((0, y.addDisposableDomListener)(this.textarea,"keydown",(function(t){return e._keyDown(t)}),!0)),this.register((0, y.addDisposableDomListener)(this.textarea,"keypress",(function(t){return e._keyPress(t)}),!0)),this.register((0, y.addDisposableDomListener)(this.textarea,"compositionstart",(function(){return e._compositionHelper.compositionstart()}))),this.register((0, y.addDisposableDomListener)(this.textarea,"compositionupdate",(function(t){return e._compositionHelper.compositionupdate(t)}))),this.register((0, y.addDisposableDomListener)(this.textarea,"compositionend",(function(){return e._compositionHelper.compositionend()}))),this.register((0, y.addDisposableDomListener)(this.textarea,"input",(function(t){return e._inputEvent(t)}),!0)),this.register(this.onRender((function(){return e._compositionHelper.updateCompositionElements()}))),this.register(this.onRender((function(t){return e._queueLinkification(t.start,t.end)})));},t.prototype.open=function(e){var t=this;if(!e)throw new Error("Terminal requires a parent element.");e.isConnected||this._logService.debug("Terminal.open was called on an element that was not attached to the DOM"),this._document=e.ownerDocument,this.element=this._document.createElement("div"),this.element.dir="ltr",this.element.classList.add("terminal"),this.element.classList.add("xterm"),this.element.setAttribute("tabindex","0"),e.appendChild(this.element);var r=U.createDocumentFragment();this._viewportElement=U.createElement("div"),this._viewportElement.classList.add("xterm-viewport"),r.appendChild(this._viewportElement),this._viewportScrollArea=U.createElement("div"),this._viewportScrollArea.classList.add("xterm-scroll-area"),this._viewportElement.appendChild(this._viewportScrollArea),this.screenElement=U.createElement("div"),this.screenElement.classList.add("xterm-screen"),this._helperContainer=U.createElement("div"),this._helperContainer.classList.add("xterm-helpers"),this.screenElement.appendChild(this._helperContainer),r.appendChild(this.screenElement),this.textarea=U.createElement("textarea"),this.textarea.classList.add("xterm-helper-textarea"),this.textarea.setAttribute("aria-label",g.promptLabel),this.textarea.setAttribute("aria-multiline","false"),this.textarea.setAttribute("autocorrect","off"),this.textarea.setAttribute("autocapitalize","off"),this.textarea.setAttribute("spellcheck","false"),this.textarea.tabIndex=0,this.register((0, y.addDisposableDomListener)(this.textarea,"focus",(function(e){return t._onTextAreaFocus(e)}))),this.register((0, y.addDisposableDomListener)(this.textarea,"blur",(function(){return t._onTextAreaBlur()}))),this._helperContainer.appendChild(this.textarea);var i=this._instantiationService.createInstance(D.CoreBrowserService,this.textarea);this._instantiationService.setService(k.ICoreBrowserService,i),this._charSizeService=this._instantiationService.createInstance(M.CharSizeService,this._document,this._helperContainer),this._instantiationService.setService(k.ICharSizeService,this._charSizeService),this._theme=this.options.theme||this._theme,this._colorManager=new x.ColorManager(U,this.options.allowTransparency),this.register(this.optionsService.onOptionChange((function(e){return t._colorManager.onOptionsChange(e)}))),this._colorManager.setTheme(this._theme),this._characterJoinerService=this._instantiationService.createInstance(P.CharacterJoinerService),this._instantiationService.setService(k.ICharacterJoinerService,this._characterJoinerService);var n=this._createRenderer();this._renderService=this.register(this._instantiationService.createInstance(R.RenderService,n,this.rows,this.screenElement)),this._instantiationService.setService(k.IRenderService,this._renderService),this.register(this._renderService.onRenderedViewportChange((function(e){return t._onRender.fire(e)}))),this.onResize((function(e){return t._renderService.resize(e.cols,e.rows)})),this._compositionView=U.createElement("div"),this._compositionView.classList.add("composition-view"),this._compositionHelper=this._instantiationService.createInstance(c.CompositionHelper,this.textarea,this._compositionView),this._helperContainer.appendChild(this._compositionView),this.element.appendChild(r),this._soundService=this._instantiationService.createInstance(m.SoundService),this._instantiationService.setService(k.ISoundService,this._soundService),this._mouseService=this._instantiationService.createInstance(A.MouseService),this._instantiationService.setService(k.IMouseService,this._mouseService),this.viewport=this._instantiationService.createInstance(l.Viewport,(function(e){return t.scrollLines(e,!0,1)}),this._viewportElement,this._viewportScrollArea,this.element),this.viewport.onThemeChange(this._colorManager.colors),this.register(this._inputHandler.onRequestSyncScrollBar((function(){return t.viewport.syncScrollArea()}))),this.register(this.viewport),this.register(this.onCursorMove((function(){t._renderService.onCursorMove(),t._syncTextArea();}))),this.register(this.onResize((function(){return t._renderService.onResize(t.cols,t.rows)}))),this.register(this.onBlur((function(){return t._renderService.onBlur()}))),this.register(this.onFocus((function(){return t._renderService.onFocus()}))),this.register(this._renderService.onDimensionsChange((function(){return t.viewport.syncScrollArea()}))),this._selectionService=this.register(this._instantiationService.createInstance(p.SelectionService,this.element,this.screenElement,this.linkifier2)),this._instantiationService.setService(k.ISelectionService,this._selectionService),this.register(this._selectionService.onRequestScrollLines((function(e){return t.scrollLines(e.amount,e.suppressScrollEvent)}))),this.register(this._selectionService.onSelectionChange((function(){return t._onSelectionChange.fire()}))),this.register(this._selectionService.onRequestRedraw((function(e){return t._renderService.onSelectionChanged(e.start,e.end,e.columnSelectMode)}))),this.register(this._selectionService.onLinuxMouseSelection((function(e){t.textarea.value=e,t.textarea.focus(),t.textarea.select();}))),this.register(this._onScroll.event((function(e){t.viewport.syncScrollArea(),t._selectionService.refresh();}))),this.register((0, y.addDisposableDomListener)(this._viewportElement,"scroll",(function(){return t._selectionService.refresh()}))),this._mouseZoneManager=this._instantiationService.createInstance(b.MouseZoneManager,this.element,this.screenElement),this.register(this._mouseZoneManager),this.register(this.onScroll((function(){return t._mouseZoneManager.clearAll()}))),this.linkifier.attachToDom(this.element,this._mouseZoneManager),this.linkifier2.attachToDom(this.screenElement,this._mouseService,this._renderService),this.register(this._instantiationService.createInstance(H.BufferDecorationRenderer,this.screenElement)),this.register((0, y.addDisposableDomListener)(this.element,"mousedown",(function(e){return t._selectionService.onMouseDown(e)}))),this.coreMouseService.areMouseEventsActive?(this._selectionService.disable(),this.element.classList.add("enable-mouse-events")):this._selectionService.enable(),this.options.screenReaderMode&&(this._accessibilityManager=new S.AccessibilityManager(this,this._renderService)),this.options.overviewRulerWidth&&(this._overviewRulerRenderer=this._instantiationService.createInstance(j.OverviewRulerRenderer,this._viewportElement,this.screenElement)),this.optionsService.onOptionChange((function(){!t._overviewRulerRenderer&&t.options.overviewRulerWidth&&t._viewportElement&&t.screenElement&&(t._overviewRulerRenderer=t._instantiationService.createInstance(j.OverviewRulerRenderer,t._viewportElement,t.screenElement));})),this._charSizeService.measure(),this.refresh(0,this.rows-1),this._initGlobal(),this.bindMouse();},t.prototype._createRenderer=function(){switch(this.options.rendererType){case"canvas":return this._instantiationService.createInstance(_.Renderer,this._colorManager.colors,this.screenElement,this.linkifier,this.linkifier2);case"dom":return this._instantiationService.createInstance(C.DomRenderer,this._colorManager.colors,this.element,this.screenElement,this._viewportElement,this.linkifier,this.linkifier2);default:throw new Error('Unrecognized rendererType "'+this.options.rendererType+'"')}},t.prototype._setTheme=function(e){var t,r,i;this._theme=e,null===(t=this._colorManager)||void 0===t||t.setTheme(e),null===(r=this._renderService)||void 0===r||r.setColors(this._colorManager.colors),null===(i=this.viewport)||void 0===i||i.onThemeChange(this._colorManager.colors);},t.prototype.bindMouse=function(){var e=this,t=this,r=this.element;function i(e){var r,i,n=t._mouseService.getRawByteCoords(e,t.screenElement,t.cols,t.rows);if(!n)return !1;switch(e.overrideType||e.type){case"mousemove":i=32,void 0===e.buttons?(r=3,void 0!==e.button&&(r=e.button<3?e.button:3)):r=1&e.buttons?0:4&e.buttons?1:2&e.buttons?2:3;break;case"mouseup":i=0,r=e.button<3?e.button:3;break;case"mousedown":i=1,r=e.button<3?e.button:3;break;case"wheel":if(0===t.viewport.getLinesScrolled(e))return !1;i=e.deltaY<0?0:1,r=4;break;default:return !1}return !(void 0===i||void 0===r||r>4)&&t.coreMouseService.triggerMouseEvent({col:n.x-33,row:n.y-33,button:r,action:i,ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey})}var n={mouseup:null,wheel:null,mousedrag:null,mousemove:null},o=function(t){return i(t),t.buttons||(e._document.removeEventListener("mouseup",n.mouseup),n.mousedrag&&e._document.removeEventListener("mousemove",n.mousedrag)),e.cancel(t)},s=function(t){return i(t),e.cancel(t,!0)},a=function(e){e.buttons&&i(e);},c=function(e){e.buttons||i(e);};this.register(this.coreMouseService.onProtocolChange((function(t){t?("debug"===e.optionsService.rawOptions.logLevel&&e._logService.debug("Binding to mouse events:",e.coreMouseService.explainEvents(t)),e.element.classList.add("enable-mouse-events"),e._selectionService.disable()):(e._logService.debug("Unbinding from mouse events."),e.element.classList.remove("enable-mouse-events"),e._selectionService.enable()),8&t?n.mousemove||(r.addEventListener("mousemove",c),n.mousemove=c):(r.removeEventListener("mousemove",n.mousemove),n.mousemove=null),16&t?n.wheel||(r.addEventListener("wheel",s,{passive:!1}),n.wheel=s):(r.removeEventListener("wheel",n.wheel),n.wheel=null),2&t?n.mouseup||(n.mouseup=o):(e._document.removeEventListener("mouseup",n.mouseup),n.mouseup=null),4&t?n.mousedrag||(n.mousedrag=a):(e._document.removeEventListener("mousemove",n.mousedrag),n.mousedrag=null);}))),this.coreMouseService.activeProtocol=this.coreMouseService.activeProtocol,this.register((0, y.addDisposableDomListener)(r,"mousedown",(function(t){if(t.preventDefault(),e.focus(),e.coreMouseService.areMouseEventsActive&&!e._selectionService.shouldForceSelection(t))return i(t),n.mouseup&&e._document.addEventListener("mouseup",n.mouseup),n.mousedrag&&e._document.addEventListener("mousemove",n.mousedrag),e.cancel(t)}))),this.register((0, y.addDisposableDomListener)(r,"wheel",(function(t){if(!n.wheel){if(!e.buffer.hasScrollback){var r=e.viewport.getLinesScrolled(t);if(0===r)return;for(var i=u.C0.ESC+(e.coreService.decPrivateModes.applicationCursorKeys?"O":"[")+(t.deltaY<0?"A":"B"),o="",s=0;s<Math.abs(r);s++)o+=i;return e.coreService.triggerDataEvent(o,!0),e.cancel(t,!0)}return e.viewport.onWheel(t)?e.cancel(t):void 0}}),{passive:!1})),this.register((0, y.addDisposableDomListener)(r,"touchstart",(function(t){if(!e.coreMouseService.areMouseEventsActive)return e.viewport.onTouchStart(t),e.cancel(t)}),{passive:!0})),this.register((0, y.addDisposableDomListener)(r,"touchmove",(function(t){if(!e.coreMouseService.areMouseEventsActive)return e.viewport.onTouchMove(t)?void 0:e.cancel(t)}),{passive:!1}));},t.prototype.refresh=function(e,t){var r;null===(r=this._renderService)||void 0===r||r.refreshRows(e,t);},t.prototype._queueLinkification=function(e,t){var r;null===(r=this.linkifier)||void 0===r||r.linkifyRows(e,t);},t.prototype.updateCursorStyle=function(e){var t;(null===(t=this._selectionService)||void 0===t?void 0:t.shouldColumnSelect(e))?this.element.classList.add("column-select"):this.element.classList.remove("column-select");},t.prototype._showCursor=function(){this.coreService.isCursorInitialized||(this.coreService.isCursorInitialized=!0,this.refresh(this.buffer.y,this.buffer.y));},t.prototype.scrollLines=function(t,r,i){void 0===i&&(i=0),e.prototype.scrollLines.call(this,t,r,i),this.refresh(0,this.rows-1);},t.prototype.paste=function(e){(0, h.paste)(e,this.textarea,this.coreService);},t.prototype.attachCustomKeyEventHandler=function(e){this._customKeyEventHandler=e;},t.prototype.registerLinkMatcher=function(e,t,r){var i=this.linkifier.registerLinkMatcher(e,t,r);return this.refresh(0,this.rows-1),i},t.prototype.deregisterLinkMatcher=function(e){this.linkifier.deregisterLinkMatcher(e)&&this.refresh(0,this.rows-1);},t.prototype.registerLinkProvider=function(e){return this.linkifier2.registerLinkProvider(e)},t.prototype.registerCharacterJoiner=function(e){if(!this._characterJoinerService)throw new Error("Terminal must be opened first");var t=this._characterJoinerService.register(e);return this.refresh(0,this.rows-1),t},t.prototype.deregisterCharacterJoiner=function(e){if(!this._characterJoinerService)throw new Error("Terminal must be opened first");this._characterJoinerService.deregister(e)&&this.refresh(0,this.rows-1);},Object.defineProperty(t.prototype,"markers",{get:function(){return this.buffer.markers},enumerable:!1,configurable:!0}),t.prototype.addMarker=function(e){if(this.buffer===this.buffers.normal)return this.buffer.addMarker(this.buffer.ybase+this.buffer.y+e)},t.prototype.registerDecoration=function(e){return this._decorationService.registerDecoration(e)},t.prototype.hasSelection=function(){return !!this._selectionService&&this._selectionService.hasSelection},t.prototype.select=function(e,t,r){this._selectionService.setSelection(e,t,r);},t.prototype.getSelection=function(){return this._selectionService?this._selectionService.selectionText:""},t.prototype.getSelectionPosition=function(){if(this._selectionService&&this._selectionService.hasSelection)return {startColumn:this._selectionService.selectionStart[0],startRow:this._selectionService.selectionStart[1],endColumn:this._selectionService.selectionEnd[0],endRow:this._selectionService.selectionEnd[1]}},t.prototype.clearSelection=function(){var e;null===(e=this._selectionService)||void 0===e||e.clearSelection();},t.prototype.selectAll=function(){var e;null===(e=this._selectionService)||void 0===e||e.selectAll();},t.prototype.selectLines=function(e,t){var r;null===(r=this._selectionService)||void 0===r||r.selectLines(e,t);},t.prototype._keyDown=function(e){if(this._keyDownHandled=!1,this._keyDownSeen=!0,this._customKeyEventHandler&&!1===this._customKeyEventHandler(e))return !1;var t=this.browser.isMac&&this.options.macOptionIsMeta&&e.altKey;if(!t&&!this._compositionHelper.keydown(e))return this.buffer.ybase!==this.buffer.ydisp&&this._bufferService.scrollToBottom(),!1;t||"Dead"!==e.key&&"AltGraph"!==e.key||(this._unprocessedDeadKey=!0);var r=(0, w.evaluateKeyboardEvent)(e,this.coreService.decPrivateModes.applicationCursorKeys,this.browser.isMac,this.options.macOptionIsMeta);if(this.updateCursorStyle(e),3===r.type||2===r.type){var i=this.rows-1;return this.scrollLines(2===r.type?-i:i),this.cancel(e,!0)}return 1===r.type&&this.selectAll(),!!this._isThirdLevelShift(this.browser,e)||(r.cancel&&this.cancel(e,!0),!r.key||!!(e.key&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&1===e.key.length&&e.key.charCodeAt(0)>=65&&e.key.charCodeAt(0)<=90)||(this._unprocessedDeadKey?(this._unprocessedDeadKey=!1,!0):(r.key!==u.C0.ETX&&r.key!==u.C0.CR||(this.textarea.value=""),this._onKey.fire({key:r.key,domEvent:e}),this._showCursor(),this.coreService.triggerDataEvent(r.key,!0),this.optionsService.rawOptions.screenReaderMode?void(this._keyDownHandled=!0):this.cancel(e,!0))))},t.prototype._isThirdLevelShift=function(e,t){var r=e.isMac&&!this.options.macOptionIsMeta&&t.altKey&&!t.ctrlKey&&!t.metaKey||e.isWindows&&t.altKey&&t.ctrlKey&&!t.metaKey||e.isWindows&&t.getModifierState("AltGraph");return "keypress"===t.type?r:r&&(!t.keyCode||t.keyCode>47)},t.prototype._keyUp=function(e){this._keyDownSeen=!1,this._customKeyEventHandler&&!1===this._customKeyEventHandler(e)||(function(e){return 16===e.keyCode||17===e.keyCode||18===e.keyCode}(e)||this.focus(),this.updateCursorStyle(e),this._keyPressHandled=!1);},t.prototype._keyPress=function(e){var t;if(this._keyPressHandled=!1,this._keyDownHandled)return !1;if(this._customKeyEventHandler&&!1===this._customKeyEventHandler(e))return !1;if(this.cancel(e),e.charCode)t=e.charCode;else if(null===e.which||void 0===e.which)t=e.keyCode;else {if(0===e.which||0===e.charCode)return !1;t=e.which;}return !(!t||(e.altKey||e.ctrlKey||e.metaKey)&&!this._isThirdLevelShift(this.browser,e)||(t=String.fromCharCode(t),this._onKey.fire({key:t,domEvent:e}),this._showCursor(),this.coreService.triggerDataEvent(t,!0),this._keyPressHandled=!0,this._unprocessedDeadKey=!1,0))},t.prototype._inputEvent=function(e){if(e.data&&"insertText"===e.inputType&&(!e.composed||!this._keyDownSeen)&&!this.optionsService.rawOptions.screenReaderMode){if(this._keyPressHandled)return !1;this._unprocessedDeadKey=!1;var t=e.data;return this.coreService.triggerDataEvent(t,!0),this.cancel(e),!0}return !1},t.prototype.bell=function(){var e;this._soundBell()&&(null===(e=this._soundService)||void 0===e||e.playBellSound()),this._onBell.fire();},t.prototype.resize=function(t,r){t!==this.cols||r!==this.rows?e.prototype.resize.call(this,t,r):this._charSizeService&&!this._charSizeService.hasValidSize&&this._charSizeService.measure();},t.prototype._afterResize=function(e,t){var r,i;null===(r=this._charSizeService)||void 0===r||r.measure(),null===(i=this.viewport)||void 0===i||i.syncScrollArea(!0);},t.prototype.clear=function(){if(0!==this.buffer.ybase||0!==this.buffer.y){this.buffer.clearAllMarkers(),this.buffer.lines.set(0,this.buffer.lines.get(this.buffer.ybase+this.buffer.y)),this.buffer.lines.length=1,this.buffer.ydisp=0,this.buffer.ybase=0,this.buffer.y=0;for(var e=1;e<this.rows;e++)this.buffer.lines.push(this.buffer.getBlankLine(E.DEFAULT_ATTR_DATA));this.refresh(0,this.rows-1),this._onScroll.fire({position:this.buffer.ydisp,source:0});}},t.prototype.reset=function(){var t,r;this.options.rows=this.rows,this.options.cols=this.cols;var i=this._customKeyEventHandler;this._setup(),e.prototype.reset.call(this),null===(t=this._selectionService)||void 0===t||t.reset(),this._decorationService.reset(),this._customKeyEventHandler=i,this.refresh(0,this.rows-1),null===(r=this.viewport)||void 0===r||r.syncScrollArea();},t.prototype.clearTextureAtlas=function(){var e;null===(e=this._renderService)||void 0===e||e.clearTextureAtlas();},t.prototype._reportFocus=function(){var e;(null===(e=this.element)||void 0===e?void 0:e.classList.contains("focus"))?this.coreService.triggerDataEvent(u.C0.ESC+"[I"):this.coreService.triggerDataEvent(u.C0.ESC+"[O");},t.prototype._reportWindowsOptions=function(e){if(this._renderService)switch(e){case f.WindowsOptionsReportType.GET_WIN_SIZE_PIXELS:var t=this._renderService.dimensions.scaledCanvasWidth.toFixed(0),r=this._renderService.dimensions.scaledCanvasHeight.toFixed(0);this.coreService.triggerDataEvent(u.C0.ESC+"[4;"+r+";"+t+"t");break;case f.WindowsOptionsReportType.GET_CELL_SIZE_PIXELS:var i=this._renderService.dimensions.scaledCellWidth.toFixed(0),n=this._renderService.dimensions.scaledCellHeight.toFixed(0);this.coreService.triggerDataEvent(u.C0.ESC+"[6;"+n+";"+i+"t");}},t.prototype.cancel=function(e,t){if(this.options.cancelEvents||t)return e.preventDefault(),e.stopPropagation(),!1},t.prototype._visualBell=function(){return !1},t.prototype._soundBell=function(){return "sound"===this.options.bellStyle},t}(T.CoreTerminal);t.Terminal=q;},9924:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.TimeBasedDebouncer=void 0;var r=function(){function e(e,t){void 0===t&&(t=1e3),this._renderCallback=e,this._debounceThresholdMS=t,this._lastRefreshMs=0,this._additionalRefreshRequested=!1;}return e.prototype.dispose=function(){this._refreshTimeoutID&&clearTimeout(this._refreshTimeoutID);},e.prototype.refresh=function(e,t,r){var i=this;this._rowCount=r,e=void 0!==e?e:0,t=void 0!==t?t:this._rowCount-1,this._rowStart=void 0!==this._rowStart?Math.min(this._rowStart,e):e,this._rowEnd=void 0!==this._rowEnd?Math.max(this._rowEnd,t):t;var n=Date.now();if(n-this._lastRefreshMs>=this._debounceThresholdMS)this._lastRefreshMs=n,this._innerRefresh();else if(!this._additionalRefreshRequested){var o=n-this._lastRefreshMs,s=this._debounceThresholdMS-o;this._additionalRefreshRequested=!0,this._refreshTimeoutID=window.setTimeout((function(){i._lastRefreshMs=Date.now(),i._innerRefresh(),i._additionalRefreshRequested=!1,i._refreshTimeoutID=void 0;}),s);}},e.prototype._innerRefresh=function(){if(void 0!==this._rowStart&&void 0!==this._rowEnd&&void 0!==this._rowCount){var e=Math.max(this._rowStart,0),t=Math.min(this._rowEnd,this._rowCount-1);this._rowStart=void 0,this._rowEnd=void 0,this._renderCallback(e,t);}},e}();t.TimeBasedDebouncer=r;},1680:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.Viewport=void 0;var a=r(844),c=r(3656),l=r(4725),h=r(2585),u=function(e){function t(t,r,i,n,o,s,a,l){var h=e.call(this)||this;return h._scrollLines=t,h._viewportElement=r,h._scrollArea=i,h._element=n,h._bufferService=o,h._optionsService=s,h._charSizeService=a,h._renderService=l,h.scrollBarWidth=0,h._currentRowHeight=0,h._currentScaledCellHeight=0,h._lastRecordedBufferLength=0,h._lastRecordedViewportHeight=0,h._lastRecordedBufferHeight=0,h._lastTouchY=0,h._lastScrollTop=0,h._wheelPartialScroll=0,h._refreshAnimationFrame=null,h._ignoreNextScrollEvent=!1,h.scrollBarWidth=h._viewportElement.offsetWidth-h._scrollArea.offsetWidth||15,h.register((0, c.addDisposableDomListener)(h._viewportElement,"scroll",h._onScroll.bind(h))),h._activeBuffer=h._bufferService.buffer,h.register(h._bufferService.buffers.onBufferActivate((function(e){return h._activeBuffer=e.activeBuffer}))),h._renderDimensions=h._renderService.dimensions,h.register(h._renderService.onDimensionsChange((function(e){return h._renderDimensions=e}))),setTimeout((function(){return h.syncScrollArea()}),0),h}return n(t,e),t.prototype.onThemeChange=function(e){this._viewportElement.style.backgroundColor=e.background.css;},t.prototype._refresh=function(e){var t=this;if(e)return this._innerRefresh(),void(null!==this._refreshAnimationFrame&&cancelAnimationFrame(this._refreshAnimationFrame));null===this._refreshAnimationFrame&&(this._refreshAnimationFrame=requestAnimationFrame((function(){return t._innerRefresh()})));},t.prototype._innerRefresh=function(){if(this._charSizeService.height>0){this._currentRowHeight=this._renderService.dimensions.scaledCellHeight/window.devicePixelRatio,this._currentScaledCellHeight=this._renderService.dimensions.scaledCellHeight,this._lastRecordedViewportHeight=this._viewportElement.offsetHeight;var e=Math.round(this._currentRowHeight*this._lastRecordedBufferLength)+(this._lastRecordedViewportHeight-this._renderService.dimensions.canvasHeight);this._lastRecordedBufferHeight!==e&&(this._lastRecordedBufferHeight=e,this._scrollArea.style.height=this._lastRecordedBufferHeight+"px");}var t=this._bufferService.buffer.ydisp*this._currentRowHeight;this._viewportElement.scrollTop!==t&&(this._ignoreNextScrollEvent=!0,this._viewportElement.scrollTop=t),this._refreshAnimationFrame=null;},t.prototype.syncScrollArea=function(e){if(void 0===e&&(e=!1),this._lastRecordedBufferLength!==this._bufferService.buffer.lines.length)return this._lastRecordedBufferLength=this._bufferService.buffer.lines.length,void this._refresh(e);this._lastRecordedViewportHeight===this._renderService.dimensions.canvasHeight&&this._lastScrollTop===this._activeBuffer.ydisp*this._currentRowHeight&&this._renderDimensions.scaledCellHeight===this._currentScaledCellHeight||this._refresh(e);},t.prototype._onScroll=function(e){if(this._lastScrollTop=this._viewportElement.scrollTop,this._viewportElement.offsetParent){if(this._ignoreNextScrollEvent)return this._ignoreNextScrollEvent=!1,void this._scrollLines(0);var t=Math.round(this._lastScrollTop/this._currentRowHeight)-this._bufferService.buffer.ydisp;this._scrollLines(t);}},t.prototype._bubbleScroll=function(e,t){var r=this._viewportElement.scrollTop+this._lastRecordedViewportHeight;return !(t<0&&0!==this._viewportElement.scrollTop||t>0&&r<this._lastRecordedBufferHeight)||(e.cancelable&&e.preventDefault(),!1)},t.prototype.onWheel=function(e){var t=this._getPixelsScrolled(e);return 0!==t&&(this._viewportElement.scrollTop+=t,this._bubbleScroll(e,t))},t.prototype._getPixelsScrolled=function(e){if(0===e.deltaY||e.shiftKey)return 0;var t=this._applyScrollModifier(e.deltaY,e);return e.deltaMode===WheelEvent.DOM_DELTA_LINE?t*=this._currentRowHeight:e.deltaMode===WheelEvent.DOM_DELTA_PAGE&&(t*=this._currentRowHeight*this._bufferService.rows),t},t.prototype.getLinesScrolled=function(e){if(0===e.deltaY||e.shiftKey)return 0;var t=this._applyScrollModifier(e.deltaY,e);return e.deltaMode===WheelEvent.DOM_DELTA_PIXEL?(t/=this._currentRowHeight+0,this._wheelPartialScroll+=t,t=Math.floor(Math.abs(this._wheelPartialScroll))*(this._wheelPartialScroll>0?1:-1),this._wheelPartialScroll%=1):e.deltaMode===WheelEvent.DOM_DELTA_PAGE&&(t*=this._bufferService.rows),t},t.prototype._applyScrollModifier=function(e,t){var r=this._optionsService.rawOptions.fastScrollModifier;return "alt"===r&&t.altKey||"ctrl"===r&&t.ctrlKey||"shift"===r&&t.shiftKey?e*this._optionsService.rawOptions.fastScrollSensitivity*this._optionsService.rawOptions.scrollSensitivity:e*this._optionsService.rawOptions.scrollSensitivity},t.prototype.onTouchStart=function(e){this._lastTouchY=e.touches[0].pageY;},t.prototype.onTouchMove=function(e){var t=this._lastTouchY-e.touches[0].pageY;return this._lastTouchY=e.touches[0].pageY,0!==t&&(this._viewportElement.scrollTop+=t,this._bubbleScroll(e,t))},o([s(4,h.IBufferService),s(5,h.IOptionsService),s(6,l.ICharSizeService),s(7,l.IRenderService)],t)}(a.Disposable);t.Viewport=u;},3107:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},a=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.BufferDecorationRenderer=void 0;var c=r(3656),l=r(4725),h=r(844),u=r(2585),f=function(e){function t(t,r,i,n){var o=e.call(this)||this;return o._screenElement=t,o._bufferService=r,o._decorationService=i,o._renderService=n,o._decorationElements=new Map,o._altBufferIsActive=!1,o._dimensionsChanged=!1,o._container=document.createElement("div"),o._container.classList.add("xterm-decoration-container"),o._screenElement.appendChild(o._container),o.register(o._renderService.onRenderedViewportChange((function(){return o._queueRefresh()}))),o.register(o._renderService.onDimensionsChange((function(){o._dimensionsChanged=!0,o._queueRefresh();}))),o.register((0, c.addDisposableDomListener)(window,"resize",(function(){return o._queueRefresh()}))),o.register(o._bufferService.buffers.onBufferActivate((function(){o._altBufferIsActive=o._bufferService.buffer===o._bufferService.buffers.alt;}))),o.register(o._decorationService.onDecorationRegistered((function(){return o._queueRefresh()}))),o.register(o._decorationService.onDecorationRemoved((function(e){return o._removeDecoration(e)}))),o}return n(t,e),t.prototype.dispose=function(){this._container.remove(),this._decorationElements.clear(),e.prototype.dispose.call(this);},t.prototype._queueRefresh=function(){var e=this;void 0===this._animationFrame&&(this._animationFrame=this._renderService.addRefreshCallback((function(){e.refreshDecorations(),e._animationFrame=void 0;})));},t.prototype.refreshDecorations=function(){var e,t;try{for(var r=a(this._decorationService.decorations),i=r.next();!i.done;i=r.next()){var n=i.value;this._renderDecoration(n);}}catch(t){e={error:t};}finally{try{i&&!i.done&&(t=r.return)&&t.call(r);}finally{if(e)throw e.error}}this._dimensionsChanged=!1;},t.prototype._renderDecoration=function(e){this._refreshStyle(e),this._dimensionsChanged&&this._refreshXPosition(e);},t.prototype._createElement=function(e){var t,r=document.createElement("div");r.classList.add("xterm-decoration"),r.style.width=Math.round((e.options.width||1)*this._renderService.dimensions.actualCellWidth)+"px",r.style.height=(e.options.height||1)*this._renderService.dimensions.actualCellHeight+"px",r.style.top=(e.marker.line-this._bufferService.buffers.active.ydisp)*this._renderService.dimensions.actualCellHeight+"px",r.style.lineHeight=this._renderService.dimensions.actualCellHeight+"px";var i=null!==(t=e.options.x)&&void 0!==t?t:0;return i&&i>this._bufferService.cols&&(r.style.display="none"),this._refreshXPosition(e,r),r},t.prototype._refreshStyle=function(e){var t=this,r=e.marker.line-this._bufferService.buffers.active.ydisp;if(r<0||r>=this._bufferService.rows)e.element&&(e.element.style.display="none",e.onRenderEmitter.fire(e.element));else {var i=this._decorationElements.get(e);i||(e.onDispose((function(){return t._removeDecoration(e)})),i=this._createElement(e),e.element=i,this._decorationElements.set(e,i),this._container.appendChild(i)),i.style.top=r*this._renderService.dimensions.actualCellHeight+"px",i.style.display=this._altBufferIsActive?"none":"block",e.onRenderEmitter.fire(i);}},t.prototype._refreshXPosition=function(e,t){var r;if(void 0===t&&(t=e.element),t){var i=null!==(r=e.options.x)&&void 0!==r?r:0;"right"===(e.options.anchor||"left")?t.style.right=i?i*this._renderService.dimensions.actualCellWidth+"px":"":t.style.left=i?i*this._renderService.dimensions.actualCellWidth+"px":"";}},t.prototype._removeDecoration=function(e){var t;null===(t=this._decorationElements.get(e))||void 0===t||t.remove(),this._decorationElements.delete(e);},o([s(1,u.IBufferService),s(2,u.IDecorationService),s(3,l.IRenderService)],t)}(h.Disposable);t.BufferDecorationRenderer=f;},5871:function(e,t){var r=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.ColorZoneStore=void 0;var i=function(){function e(){this._zones=[],this._zonePool=[],this._zonePoolIndex=0,this._linePadding={full:0,left:0,center:0,right:0};}return Object.defineProperty(e.prototype,"zones",{get:function(){return this._zonePool.length=Math.min(this._zonePool.length,this._zones.length),this._zones},enumerable:!1,configurable:!0}),e.prototype.clear=function(){this._zones.length=0,this._zonePoolIndex=0;},e.prototype.addDecoration=function(e){var t,i;if(e.options.overviewRulerOptions){try{for(var n=r(this._zones),o=n.next();!o.done;o=n.next()){var s=o.value;if(s.color===e.options.overviewRulerOptions.color&&s.position===e.options.overviewRulerOptions.position){if(this._lineIntersectsZone(s,e.marker.line))return;if(this._lineAdjacentToZone(s,e.marker.line,e.options.overviewRulerOptions.position))return void this._addLineToZone(s,e.marker.line)}}}catch(e){t={error:e};}finally{try{o&&!o.done&&(i=n.return)&&i.call(n);}finally{if(t)throw t.error}}if(this._zonePoolIndex<this._zonePool.length)return this._zonePool[this._zonePoolIndex].color=e.options.overviewRulerOptions.color,this._zonePool[this._zonePoolIndex].position=e.options.overviewRulerOptions.position,this._zonePool[this._zonePoolIndex].startBufferLine=e.marker.line,this._zonePool[this._zonePoolIndex].endBufferLine=e.marker.line,void this._zones.push(this._zonePool[this._zonePoolIndex++]);this._zones.push({color:e.options.overviewRulerOptions.color,position:e.options.overviewRulerOptions.position,startBufferLine:e.marker.line,endBufferLine:e.marker.line}),this._zonePool.push(this._zones[this._zones.length-1]),this._zonePoolIndex++;}},e.prototype.setPadding=function(e){this._linePadding=e;},e.prototype._lineIntersectsZone=function(e,t){return t>=e.startBufferLine&&t<=e.endBufferLine},e.prototype._lineAdjacentToZone=function(e,t,r){return t>=e.startBufferLine-this._linePadding[r||"full"]&&t<=e.endBufferLine+this._linePadding[r||"full"]},e.prototype._addLineToZone=function(e,t){e.startBufferLine=Math.min(e.startBufferLine,t),e.endBufferLine=Math.max(e.endBufferLine,t);},e}();t.ColorZoneStore=i;},5744:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},a=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.OverviewRulerRenderer=void 0;var c=r(5871),l=r(3656),h=r(4725),u=r(844),f=r(2585),_={full:0,left:0,center:0,right:0},d={full:0,left:0,center:0,right:0},p={full:0,left:0,center:0,right:0},v=function(e){function t(t,r,i,n,o,s){var a,l=e.call(this)||this;l._viewportElement=t,l._screenElement=r,l._bufferService=i,l._decorationService=n,l._renderService=o,l._optionsService=s,l._colorZoneStore=new c.ColorZoneStore,l._shouldUpdateDimensions=!0,l._shouldUpdateAnchor=!0,l._lastKnownBufferLength=0,l._canvas=document.createElement("canvas"),l._canvas.classList.add("xterm-decoration-overview-ruler"),l._refreshCanvasDimensions(),null===(a=l._viewportElement.parentElement)||void 0===a||a.insertBefore(l._canvas,l._viewportElement);var h=l._canvas.getContext("2d");if(!h)throw new Error("Ctx cannot be null");return l._ctx=h,l._registerDecorationListeners(),l._registerBufferChangeListeners(),l._registerDimensionChangeListeners(),l}return n(t,e),Object.defineProperty(t.prototype,"_width",{get:function(){return this._optionsService.options.overviewRulerWidth||0},enumerable:!1,configurable:!0}),t.prototype._registerDecorationListeners=function(){var e=this;this.register(this._decorationService.onDecorationRegistered((function(){return e._queueRefresh(void 0,!0)}))),this.register(this._decorationService.onDecorationRemoved((function(){return e._queueRefresh(void 0,!0)})));},t.prototype._registerBufferChangeListeners=function(){var e=this;this.register(this._renderService.onRenderedViewportChange((function(){return e._queueRefresh()}))),this.register(this._bufferService.buffers.onBufferActivate((function(){e._canvas.style.display=e._bufferService.buffer===e._bufferService.buffers.alt?"none":"block";}))),this.register(this._bufferService.onScroll((function(){e._lastKnownBufferLength!==e._bufferService.buffers.normal.lines.length&&(e._refreshDrawHeightConstants(),e._refreshColorZonePadding());})));},t.prototype._registerDimensionChangeListeners=function(){var e=this;this.register(this._renderService.onRender((function(){e._containerHeight&&e._containerHeight===e._screenElement.clientHeight||(e._queueRefresh(!0),e._containerHeight=e._screenElement.clientHeight);}))),this.register(this._optionsService.onOptionChange((function(t){"overviewRulerWidth"===t&&e._queueRefresh(!0);}))),this.register((0, l.addDisposableDomListener)(window,"resize",(function(){e._queueRefresh(!0);}))),this._queueRefresh(!0);},t.prototype.dispose=function(){var t;null===(t=this._canvas)||void 0===t||t.remove(),e.prototype.dispose.call(this);},t.prototype._refreshDrawConstants=function(){var e=Math.floor(this._canvas.width/3),t=Math.ceil(this._canvas.width/3);d.full=this._canvas.width,d.left=e,d.center=t,d.right=e,this._refreshDrawHeightConstants(),p.full=0,p.left=0,p.center=d.left,p.right=d.left+d.center;},t.prototype._refreshDrawHeightConstants=function(){_.full=Math.round(2*window.devicePixelRatio);var e=this._canvas.height/this._bufferService.buffer.lines.length,t=Math.round(Math.max(Math.min(e,12),6)*window.devicePixelRatio);_.left=t,_.center=t,_.right=t;},t.prototype._refreshColorZonePadding=function(){this._colorZoneStore.setPadding({full:Math.floor(this._bufferService.buffers.active.lines.length/(this._canvas.height-1)*_.full),left:Math.floor(this._bufferService.buffers.active.lines.length/(this._canvas.height-1)*_.left),center:Math.floor(this._bufferService.buffers.active.lines.length/(this._canvas.height-1)*_.center),right:Math.floor(this._bufferService.buffers.active.lines.length/(this._canvas.height-1)*_.right)}),this._lastKnownBufferLength=this._bufferService.buffers.normal.lines.length;},t.prototype._refreshCanvasDimensions=function(){this._canvas.style.width=this._width+"px",this._canvas.width=Math.round(this._width*window.devicePixelRatio),this._canvas.style.height=this._screenElement.clientHeight+"px",this._canvas.height=Math.round(this._screenElement.clientHeight*window.devicePixelRatio),this._refreshDrawConstants(),this._refreshColorZonePadding();},t.prototype._refreshDecorations=function(){var e,t,r,i,n,o;this._shouldUpdateDimensions&&this._refreshCanvasDimensions(),this._ctx.clearRect(0,0,this._canvas.width,this._canvas.height),this._colorZoneStore.clear();try{for(var s=a(this._decorationService.decorations),c=s.next();!c.done;c=s.next()){var l=c.value;this._colorZoneStore.addDecoration(l);}}catch(t){e={error:t};}finally{try{c&&!c.done&&(t=s.return)&&t.call(s);}finally{if(e)throw e.error}}this._ctx.lineWidth=1;var h=this._colorZoneStore.zones;try{for(var u=a(h),f=u.next();!f.done;f=u.next())"full"!==(p=f.value).position&&this._renderColorZone(p);}catch(e){r={error:e};}finally{try{f&&!f.done&&(i=u.return)&&i.call(u);}finally{if(r)throw r.error}}try{for(var _=a(h),d=_.next();!d.done;d=_.next()){var p;"full"===(p=d.value).position&&this._renderColorZone(p);}}catch(e){n={error:e};}finally{try{d&&!d.done&&(o=_.return)&&o.call(_);}finally{if(n)throw n.error}}this._shouldUpdateDimensions=!1,this._shouldUpdateAnchor=!1;},t.prototype._renderColorZone=function(e){this._ctx.fillStyle=e.color,this._ctx.fillRect(p[e.position||"full"],Math.round((this._canvas.height-1)*(e.startBufferLine/this._bufferService.buffers.active.lines.length)-_[e.position||"full"]/2),d[e.position||"full"],Math.round((this._canvas.height-1)*((e.endBufferLine-e.startBufferLine)/this._bufferService.buffers.active.lines.length)+_[e.position||"full"]));},t.prototype._queueRefresh=function(e,t){var r=this;this._shouldUpdateDimensions=e||this._shouldUpdateDimensions,this._shouldUpdateAnchor=t||this._shouldUpdateAnchor,void 0===this._animationFrame&&(this._animationFrame=window.requestAnimationFrame((function(){r._refreshDecorations(),r._animationFrame=void 0;})));},o([s(2,f.IBufferService),s(3,f.IDecorationService),s(4,h.IRenderService),s(5,f.IOptionsService)],t)}(u.Disposable);t.OverviewRulerRenderer=v;},2950:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.CompositionHelper=void 0;var o=r(4725),s=r(2585),a=function(){function e(e,t,r,i,n,o){this._textarea=e,this._compositionView=t,this._bufferService=r,this._optionsService=i,this._coreService=n,this._renderService=o,this._isComposing=!1,this._isSendingComposition=!1,this._compositionPosition={start:0,end:0},this._dataAlreadySent="";}return Object.defineProperty(e.prototype,"isComposing",{get:function(){return this._isComposing},enumerable:!1,configurable:!0}),e.prototype.compositionstart=function(){this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length,this._compositionView.textContent="",this._dataAlreadySent="",this._compositionView.classList.add("active");},e.prototype.compositionupdate=function(e){var t=this;this._compositionView.textContent=e.data,this.updateCompositionElements(),setTimeout((function(){t._compositionPosition.end=t._textarea.value.length;}),0);},e.prototype.compositionend=function(){this._finalizeComposition(!0);},e.prototype.keydown=function(e){if(this._isComposing||this._isSendingComposition){if(229===e.keyCode)return !1;if(16===e.keyCode||17===e.keyCode||18===e.keyCode)return !1;this._finalizeComposition(!1);}return 229!==e.keyCode||(this._handleAnyTextareaChanges(),!1)},e.prototype._finalizeComposition=function(e){var t=this;if(this._compositionView.classList.remove("active"),this._isComposing=!1,e){var r={start:this._compositionPosition.start,end:this._compositionPosition.end};this._isSendingComposition=!0,setTimeout((function(){if(t._isSendingComposition){t._isSendingComposition=!1;var e;r.start+=t._dataAlreadySent.length,(e=t._isComposing?t._textarea.value.substring(r.start,r.end):t._textarea.value.substring(r.start)).length>0&&t._coreService.triggerDataEvent(e,!0);}}),0);}else {this._isSendingComposition=!1;var i=this._textarea.value.substring(this._compositionPosition.start,this._compositionPosition.end);this._coreService.triggerDataEvent(i,!0);}},e.prototype._handleAnyTextareaChanges=function(){var e=this,t=this._textarea.value;setTimeout((function(){if(!e._isComposing){var r=e._textarea.value.replace(t,"");r.length>0&&(e._dataAlreadySent=r,e._coreService.triggerDataEvent(r,!0));}}),0);},e.prototype.updateCompositionElements=function(e){var t=this;if(this._isComposing){if(this._bufferService.buffer.isCursorInViewport){var r=Math.min(this._bufferService.buffer.x,this._bufferService.cols-1),i=this._renderService.dimensions.actualCellHeight,n=this._bufferService.buffer.y*this._renderService.dimensions.actualCellHeight,o=r*this._renderService.dimensions.actualCellWidth;this._compositionView.style.left=o+"px",this._compositionView.style.top=n+"px",this._compositionView.style.height=i+"px",this._compositionView.style.lineHeight=i+"px",this._compositionView.style.fontFamily=this._optionsService.rawOptions.fontFamily,this._compositionView.style.fontSize=this._optionsService.rawOptions.fontSize+"px";var s=this._compositionView.getBoundingClientRect();this._textarea.style.left=o+"px",this._textarea.style.top=n+"px",this._textarea.style.width=Math.max(s.width,1)+"px",this._textarea.style.height=Math.max(s.height,1)+"px",this._textarea.style.lineHeight=s.height+"px";}e||setTimeout((function(){return t.updateCompositionElements(!0)}),0);}},i([n(2,s.IBufferService),n(3,s.IOptionsService),n(4,s.ICoreService),n(5,o.IRenderService)],e)}();t.CompositionHelper=a;},9806:(e,t)=>{function r(e,t,r){var i=r.getBoundingClientRect(),n=e.getComputedStyle(r),o=parseInt(n.getPropertyValue("padding-left")),s=parseInt(n.getPropertyValue("padding-top"));return [t.clientX-i.left-o,t.clientY-i.top-s]}Object.defineProperty(t,"__esModule",{value:!0}),t.getRawByteCoords=t.getCoords=t.getCoordsRelativeToElement=void 0,t.getCoordsRelativeToElement=r,t.getCoords=function(e,t,i,n,o,s,a,c,l){if(s){var h=r(e,t,i);if(h)return h[0]=Math.ceil((h[0]+(l?a/2:0))/a),h[1]=Math.ceil(h[1]/c),h[0]=Math.min(Math.max(h[0],1),n+(l?1:0)),h[1]=Math.min(Math.max(h[1],1),o),h}},t.getRawByteCoords=function(e){if(e)return {x:e[0]+32,y:e[1]+32}};},9504:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.moveToCellSequence=void 0;var i=r(2584);function n(e,t,r,i){var n=e-o(r,e),a=t-o(r,t),h=Math.abs(n-a)-function(e,t,r){for(var i=0,n=e-o(r,e),a=t-o(r,t),c=0;c<Math.abs(n-a);c++){var l="A"===s(e,t)?-1:1,h=r.buffer.lines.get(n+l*c);(null==h?void 0:h.isWrapped)&&i++;}return i}(e,t,r);return l(h,c(s(e,t),i))}function o(e,t){for(var r=0,i=e.buffer.lines.get(t),n=null==i?void 0:i.isWrapped;n&&t>=0&&t<e.rows;)r++,n=null==(i=e.buffer.lines.get(--t))?void 0:i.isWrapped;return r}function s(e,t){return e>t?"A":"B"}function a(e,t,r,i,n,o){for(var s=e,a=t,c="";s!==r||a!==i;)s+=n?1:-1,n&&s>o.cols-1?(c+=o.buffer.translateBufferLineToString(a,!1,e,s),s=0,e=0,a++):!n&&s<0&&(c+=o.buffer.translateBufferLineToString(a,!1,0,e+1),e=s=o.cols-1,a--);return c+o.buffer.translateBufferLineToString(a,!1,e,s)}function c(e,t){var r=t?"O":"[";return i.C0.ESC+r+e}function l(e,t){e=Math.floor(e);for(var r="",i=0;i<e;i++)r+=t;return r}t.moveToCellSequence=function(e,t,r,i){var s,h=r.buffer.x,u=r.buffer.y;if(!r.buffer.hasScrollback)return function(e,t,r,i,s,h){return 0===n(t,i,s,h).length?"":l(a(e,t,e,t-o(s,t),!1,s).length,c("D",h))}(h,u,0,t,r,i)+n(u,t,r,i)+function(e,t,r,i,s,h){var u;u=n(t,i,s,h).length>0?i-o(s,i):t;var f=i,_=function(e,t,r,i,s,a){var c;return c=n(r,i,s,a).length>0?i-o(s,i):t,e<r&&c<=i||e>=r&&c<i?"C":"D"}(e,t,r,i,s,h);return l(a(e,u,r,f,"C"===_,s).length,c(_,h))}(h,u,e,t,r,i);if(u===t)return s=h>e?"D":"C",l(Math.abs(h-e),c(s,i));s=u>t?"D":"C";var f=Math.abs(u-t);return l(function(e,t){return t.cols-e}(u>t?e:h,r)+(f-1)*r.cols+1+((u>t?h:e)-1),c(s,i))};},4389:function(e,t,r){var i=this&&this.__assign||function(){return i=Object.assign||function(e){for(var t,r=1,i=arguments.length;r<i;r++)for(var n in t=arguments[r])Object.prototype.hasOwnProperty.call(t,n)&&(e[n]=t[n]);return e},i.apply(this,arguments)},n=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.Terminal=void 0;var o=r(3236),s=r(9042),a=r(7975),c=r(7090),l=r(5741),h=r(8285),u=["cols","rows"],f=function(){function e(e){var t=this;this._core=new o.Terminal(e),this._addonManager=new l.AddonManager,this._publicOptions=i({},this._core.options);var r=function(e){return t._core.options[e]},n=function(e,r){t._checkReadonlyOptions(e),t._core.options[e]=r;};for(var s in this._core.options){var a={get:r.bind(this,s),set:n.bind(this,s)};Object.defineProperty(this._publicOptions,s,a);}}return e.prototype._checkReadonlyOptions=function(e){if(u.includes(e))throw new Error('Option "'+e+'" can only be set in the constructor')},e.prototype._checkProposedApi=function(){if(!this._core.optionsService.rawOptions.allowProposedApi)throw new Error("You must set the allowProposedApi option to true to use proposed API")},Object.defineProperty(e.prototype,"onBell",{get:function(){return this._core.onBell},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onBinary",{get:function(){return this._core.onBinary},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onCursorMove",{get:function(){return this._core.onCursorMove},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onData",{get:function(){return this._core.onData},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onKey",{get:function(){return this._core.onKey},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onLineFeed",{get:function(){return this._core.onLineFeed},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onRender",{get:function(){return this._core.onRender},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onResize",{get:function(){return this._core.onResize},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onScroll",{get:function(){return this._core.onScroll},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onSelectionChange",{get:function(){return this._core.onSelectionChange},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onTitleChange",{get:function(){return this._core.onTitleChange},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onWriteParsed",{get:function(){return this._core.onWriteParsed},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"element",{get:function(){return this._core.element},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"parser",{get:function(){return this._checkProposedApi(),this._parser||(this._parser=new a.ParserApi(this._core)),this._parser},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"unicode",{get:function(){return this._checkProposedApi(),new c.UnicodeApi(this._core)},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"textarea",{get:function(){return this._core.textarea},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"rows",{get:function(){return this._core.rows},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"cols",{get:function(){return this._core.cols},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"buffer",{get:function(){return this._checkProposedApi(),this._buffer||(this._buffer=new h.BufferNamespaceApi(this._core)),this._buffer},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"markers",{get:function(){return this._checkProposedApi(),this._core.markers},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"modes",{get:function(){var e=this._core.coreService.decPrivateModes,t="none";switch(this._core.coreMouseService.activeProtocol){case"X10":t="x10";break;case"VT200":t="vt200";break;case"DRAG":t="drag";break;case"ANY":t="any";}return {applicationCursorKeysMode:e.applicationCursorKeys,applicationKeypadMode:e.applicationKeypad,bracketedPasteMode:e.bracketedPasteMode,insertMode:this._core.coreService.modes.insertMode,mouseTrackingMode:t,originMode:e.origin,reverseWraparoundMode:e.reverseWraparound,sendFocusMode:e.sendFocus,wraparoundMode:e.wraparound}},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"options",{get:function(){return this._publicOptions},set:function(e){for(var t in e)this._publicOptions[t]=e[t];},enumerable:!1,configurable:!0}),e.prototype.blur=function(){this._core.blur();},e.prototype.focus=function(){this._core.focus();},e.prototype.resize=function(e,t){this._verifyIntegers(e,t),this._core.resize(e,t);},e.prototype.open=function(e){this._core.open(e);},e.prototype.attachCustomKeyEventHandler=function(e){this._core.attachCustomKeyEventHandler(e);},e.prototype.registerLinkMatcher=function(e,t,r){return this._checkProposedApi(),this._core.registerLinkMatcher(e,t,r)},e.prototype.deregisterLinkMatcher=function(e){this._checkProposedApi(),this._core.deregisterLinkMatcher(e);},e.prototype.registerLinkProvider=function(e){return this._checkProposedApi(),this._core.registerLinkProvider(e)},e.prototype.registerCharacterJoiner=function(e){return this._checkProposedApi(),this._core.registerCharacterJoiner(e)},e.prototype.deregisterCharacterJoiner=function(e){this._checkProposedApi(),this._core.deregisterCharacterJoiner(e);},e.prototype.registerMarker=function(e){return void 0===e&&(e=0),this._checkProposedApi(),this._verifyIntegers(e),this._core.addMarker(e)},e.prototype.registerDecoration=function(e){var t,r,i;return this._checkProposedApi(),this._verifyPositiveIntegers(null!==(t=e.x)&&void 0!==t?t:0,null!==(r=e.width)&&void 0!==r?r:0,null!==(i=e.height)&&void 0!==i?i:0),this._core.registerDecoration(e)},e.prototype.addMarker=function(e){return this.registerMarker(e)},e.prototype.hasSelection=function(){return this._core.hasSelection()},e.prototype.select=function(e,t,r){this._verifyIntegers(e,t,r),this._core.select(e,t,r);},e.prototype.getSelection=function(){return this._core.getSelection()},e.prototype.getSelectionPosition=function(){return this._core.getSelectionPosition()},e.prototype.clearSelection=function(){this._core.clearSelection();},e.prototype.selectAll=function(){this._core.selectAll();},e.prototype.selectLines=function(e,t){this._verifyIntegers(e,t),this._core.selectLines(e,t);},e.prototype.dispose=function(){this._addonManager.dispose(),this._core.dispose();},e.prototype.scrollLines=function(e){this._verifyIntegers(e),this._core.scrollLines(e);},e.prototype.scrollPages=function(e){this._verifyIntegers(e),this._core.scrollPages(e);},e.prototype.scrollToTop=function(){this._core.scrollToTop();},e.prototype.scrollToBottom=function(){this._core.scrollToBottom();},e.prototype.scrollToLine=function(e){this._verifyIntegers(e),this._core.scrollToLine(e);},e.prototype.clear=function(){this._core.clear();},e.prototype.write=function(e,t){this._core.write(e,t);},e.prototype.writeUtf8=function(e,t){this._core.write(e,t);},e.prototype.writeln=function(e,t){this._core.write(e),this._core.write("\r\n",t);},e.prototype.paste=function(e){this._core.paste(e);},e.prototype.getOption=function(e){return this._core.optionsService.getOption(e)},e.prototype.setOption=function(e,t){this._checkReadonlyOptions(e),this._core.optionsService.setOption(e,t);},e.prototype.refresh=function(e,t){this._verifyIntegers(e,t),this._core.refresh(e,t);},e.prototype.reset=function(){this._core.reset();},e.prototype.clearTextureAtlas=function(){this._core.clearTextureAtlas();},e.prototype.loadAddon=function(e){return this._addonManager.loadAddon(this,e)},Object.defineProperty(e,"strings",{get:function(){return s},enumerable:!1,configurable:!0}),e.prototype._verifyIntegers=function(){for(var e,t,r=[],i=0;i<arguments.length;i++)r[i]=arguments[i];try{for(var o=n(r),s=o.next();!s.done;s=o.next()){var a=s.value;if(a===1/0||isNaN(a)||a%1!=0)throw new Error("This API only accepts integers")}}catch(t){e={error:t};}finally{try{s&&!s.done&&(t=o.return)&&t.call(o);}finally{if(e)throw e.error}}},e.prototype._verifyPositiveIntegers=function(){for(var e,t,r=[],i=0;i<arguments.length;i++)r[i]=arguments[i];try{for(var o=n(r),s=o.next();!s.done;s=o.next()){var a=s.value;if(a&&(a===1/0||isNaN(a)||a%1!=0||a<0))throw new Error("This API only accepts positive integers")}}catch(t){e={error:t};}finally{try{s&&!s.done&&(t=o.return)&&t.call(o);}finally{if(e)throw e.error}}},e}();t.Terminal=f;},1546:function(e,t,r){var i=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.BaseRenderLayer=void 0;var n=r(643),o=r(8803),s=r(1420),a=r(3734),c=r(1752),l=r(8055),h=r(9631),u=r(8978),f=function(){function e(e,t,r,i,n,o,s,a,c){this._container=e,this._alpha=i,this._colors=n,this._rendererId=o,this._bufferService=s,this._optionsService=a,this._decorationService=c,this._scaledCharWidth=0,this._scaledCharHeight=0,this._scaledCellWidth=0,this._scaledCellHeight=0,this._scaledCharLeft=0,this._scaledCharTop=0,this._columnSelectMode=!1,this._currentGlyphIdentifier={chars:"",code:0,bg:0,fg:0,bold:!1,dim:!1,italic:!1},this._canvas=document.createElement("canvas"),this._canvas.classList.add("xterm-"+t+"-layer"),this._canvas.style.zIndex=r.toString(),this._initCanvas(),this._container.appendChild(this._canvas);}return e.prototype.dispose=function(){var e;(0, h.removeElementFromParent)(this._canvas),null===(e=this._charAtlas)||void 0===e||e.dispose();},e.prototype._initCanvas=function(){this._ctx=(0, c.throwIfFalsy)(this._canvas.getContext("2d",{alpha:this._alpha})),this._alpha||this._clearAll();},e.prototype.onOptionsChanged=function(){},e.prototype.onBlur=function(){},e.prototype.onFocus=function(){},e.prototype.onCursorMove=function(){},e.prototype.onGridChanged=function(e,t){},e.prototype.onSelectionChanged=function(e,t,r){void 0===r&&(r=!1),this._selectionStart=e,this._selectionEnd=t,this._columnSelectMode=r;},e.prototype.setColors=function(e){this._refreshCharAtlas(e);},e.prototype._setTransparency=function(e){if(e!==this._alpha){var t=this._canvas;this._alpha=e,this._canvas=this._canvas.cloneNode(),this._initCanvas(),this._container.replaceChild(this._canvas,t),this._refreshCharAtlas(this._colors),this.onGridChanged(0,this._bufferService.rows-1);}},e.prototype._refreshCharAtlas=function(e){this._scaledCharWidth<=0&&this._scaledCharHeight<=0||(this._charAtlas=(0, s.acquireCharAtlas)(this._optionsService.rawOptions,this._rendererId,e,this._scaledCharWidth,this._scaledCharHeight),this._charAtlas.warmUp());},e.prototype.resize=function(e){this._scaledCellWidth=e.scaledCellWidth,this._scaledCellHeight=e.scaledCellHeight,this._scaledCharWidth=e.scaledCharWidth,this._scaledCharHeight=e.scaledCharHeight,this._scaledCharLeft=e.scaledCharLeft,this._scaledCharTop=e.scaledCharTop,this._canvas.width=e.scaledCanvasWidth,this._canvas.height=e.scaledCanvasHeight,this._canvas.style.width=e.canvasWidth+"px",this._canvas.style.height=e.canvasHeight+"px",this._alpha||this._clearAll(),this._refreshCharAtlas(this._colors);},e.prototype.clearTextureAtlas=function(){var e;null===(e=this._charAtlas)||void 0===e||e.clear();},e.prototype._fillCells=function(e,t,r,i){this._ctx.fillRect(e*this._scaledCellWidth,t*this._scaledCellHeight,r*this._scaledCellWidth,i*this._scaledCellHeight);},e.prototype._fillMiddleLineAtCells=function(e,t,r){void 0===r&&(r=1);var i=Math.ceil(.5*this._scaledCellHeight);this._ctx.fillRect(e*this._scaledCellWidth,(t+1)*this._scaledCellHeight-i-window.devicePixelRatio,r*this._scaledCellWidth,window.devicePixelRatio);},e.prototype._fillBottomLineAtCells=function(e,t,r){void 0===r&&(r=1),this._ctx.fillRect(e*this._scaledCellWidth,(t+1)*this._scaledCellHeight-window.devicePixelRatio-1,r*this._scaledCellWidth,window.devicePixelRatio);},e.prototype._fillLeftLineAtCell=function(e,t,r){this._ctx.fillRect(e*this._scaledCellWidth,t*this._scaledCellHeight,window.devicePixelRatio*r,this._scaledCellHeight);},e.prototype._strokeRectAtCell=function(e,t,r,i){this._ctx.lineWidth=window.devicePixelRatio,this._ctx.strokeRect(e*this._scaledCellWidth+window.devicePixelRatio/2,t*this._scaledCellHeight+window.devicePixelRatio/2,r*this._scaledCellWidth-window.devicePixelRatio,i*this._scaledCellHeight-window.devicePixelRatio);},e.prototype._clearAll=function(){this._alpha?this._ctx.clearRect(0,0,this._canvas.width,this._canvas.height):(this._ctx.fillStyle=this._colors.background.css,this._ctx.fillRect(0,0,this._canvas.width,this._canvas.height));},e.prototype._clearCells=function(e,t,r,i){this._alpha?this._ctx.clearRect(e*this._scaledCellWidth,t*this._scaledCellHeight,r*this._scaledCellWidth,i*this._scaledCellHeight):(this._ctx.fillStyle=this._colors.background.css,this._ctx.fillRect(e*this._scaledCellWidth,t*this._scaledCellHeight,r*this._scaledCellWidth,i*this._scaledCellHeight));},e.prototype._fillCharTrueColor=function(e,t,r){this._ctx.font=this._getFont(!1,!1),this._ctx.textBaseline=o.TEXT_BASELINE,this._clipRow(r);var i=!1;!1!==this._optionsService.rawOptions.customGlyphs&&(i=(0, u.tryDrawCustomChar)(this._ctx,e.getChars(),t*this._scaledCellWidth,r*this._scaledCellHeight,this._scaledCellWidth,this._scaledCellHeight)),i||this._ctx.fillText(e.getChars(),t*this._scaledCellWidth+this._scaledCharLeft,r*this._scaledCellHeight+this._scaledCharTop+this._scaledCharHeight);},e.prototype._drawChars=function(e,t,r){var s,a,c,l=this._getContrastColor(e,t,r);if(l||e.isFgRGB()||e.isBgRGB())this._drawUncachedChars(e,t,r,l);else {var h,u;e.isInverse()?(h=e.isBgDefault()?o.INVERTED_DEFAULT_COLOR:e.getBgColor(),u=e.isFgDefault()?o.INVERTED_DEFAULT_COLOR:e.getFgColor()):(u=e.isBgDefault()?n.DEFAULT_COLOR:e.getBgColor(),h=e.isFgDefault()?n.DEFAULT_COLOR:e.getFgColor()),h+=this._optionsService.rawOptions.drawBoldTextInBrightColors&&e.isBold()&&h<8?8:0,this._currentGlyphIdentifier.chars=e.getChars()||n.WHITESPACE_CELL_CHAR,this._currentGlyphIdentifier.code=e.getCode()||n.WHITESPACE_CELL_CODE,this._currentGlyphIdentifier.bg=u,this._currentGlyphIdentifier.fg=h,this._currentGlyphIdentifier.bold=!!e.isBold(),this._currentGlyphIdentifier.dim=!!e.isDim(),this._currentGlyphIdentifier.italic=!!e.isItalic();var f=!1;try{for(var _=i(this._decorationService.getDecorationsAtCell(t,r)),d=_.next();!d.done;d=_.next()){var p=d.value;if(p.backgroundColorRGB||p.foregroundColorRGB){f=!0;break}}}catch(e){s={error:e};}finally{try{d&&!d.done&&(a=_.return)&&a.call(_);}finally{if(s)throw s.error}}!f&&(null===(c=this._charAtlas)||void 0===c?void 0:c.draw(this._ctx,this._currentGlyphIdentifier,t*this._scaledCellWidth+this._scaledCharLeft,r*this._scaledCellHeight+this._scaledCharTop))||this._drawUncachedChars(e,t,r);}},e.prototype._drawUncachedChars=function(e,t,r,i){if(this._ctx.save(),this._ctx.font=this._getFont(!!e.isBold(),!!e.isItalic()),this._ctx.textBaseline=o.TEXT_BASELINE,e.isInverse())if(i)this._ctx.fillStyle=i.css;else if(e.isBgDefault())this._ctx.fillStyle=l.color.opaque(this._colors.background).css;else if(e.isBgRGB())this._ctx.fillStyle="rgb("+a.AttributeData.toColorRGB(e.getBgColor()).join(",")+")";else {var n=e.getBgColor();this._optionsService.rawOptions.drawBoldTextInBrightColors&&e.isBold()&&n<8&&(n+=8),this._ctx.fillStyle=this._colors.ansi[n].css;}else if(i)this._ctx.fillStyle=i.css;else if(e.isFgDefault())this._ctx.fillStyle=this._colors.foreground.css;else if(e.isFgRGB())this._ctx.fillStyle="rgb("+a.AttributeData.toColorRGB(e.getFgColor()).join(",")+")";else {var s=e.getFgColor();this._optionsService.rawOptions.drawBoldTextInBrightColors&&e.isBold()&&s<8&&(s+=8),this._ctx.fillStyle=this._colors.ansi[s].css;}this._clipRow(r),e.isDim()&&(this._ctx.globalAlpha=o.DIM_OPACITY);var c=!1;!1!==this._optionsService.rawOptions.customGlyphs&&(c=(0, u.tryDrawCustomChar)(this._ctx,e.getChars(),t*this._scaledCellWidth,r*this._scaledCellHeight,this._scaledCellWidth,this._scaledCellHeight)),c||this._ctx.fillText(e.getChars(),t*this._scaledCellWidth+this._scaledCharLeft,r*this._scaledCellHeight+this._scaledCharTop+this._scaledCharHeight),this._ctx.restore();},e.prototype._clipRow=function(e){this._ctx.beginPath(),this._ctx.rect(0,e*this._scaledCellHeight,this._bufferService.cols*this._scaledCellWidth,this._scaledCellHeight),this._ctx.clip();},e.prototype._getFont=function(e,t){return (t?"italic":"")+" "+(e?this._optionsService.rawOptions.fontWeightBold:this._optionsService.rawOptions.fontWeight)+" "+this._optionsService.rawOptions.fontSize*window.devicePixelRatio+"px "+this._optionsService.rawOptions.fontFamily},e.prototype._getContrastColor=function(e,t,r){var n,o,s,a,h=!1;try{for(var u=i(this._decorationService.getDecorationsAtCell(t,r)),f=u.next();!f.done;f=u.next()){var _=f.value;"top"!==_.options.layer&&h||(_.backgroundColorRGB&&(s=_.backgroundColorRGB.rgba),_.foregroundColorRGB&&(a=_.foregroundColorRGB.rgba),h="top"===_.options.layer);}}catch(e){n={error:e};}finally{try{f&&!f.done&&(o=u.return)&&o.call(u);}finally{if(n)throw n.error}}if(h||this._colors.selectionForeground&&this._isCellInSelection(t,r)&&(a=this._colors.selectionForeground.rgba),s||a||1!==this._optionsService.rawOptions.minimumContrastRatio&&!(0, c.excludeFromContrastRatioDemands)(e.getCode())){if(!s&&!a){var d=this._colors.contrastCache.getColor(e.bg,e.fg);if(void 0!==d)return d||void 0}var p=e.getFgColor(),v=e.getFgColorMode(),y=e.getBgColor(),g=e.getBgColorMode(),m=!!e.isInverse(),b=!!e.isInverse();if(m){var S=p;p=y,y=S;var C=v;v=g,g=C;}var w=this._resolveBackgroundRgba(void 0!==s?50331648:g,null!=s?s:y,m),L=this._resolveForegroundRgba(v,p,m,b),E=l.rgba.ensureContrastRatio(null!=s?s:w,null!=a?a:L,this._optionsService.rawOptions.minimumContrastRatio);if(!E){if(!a)return void this._colors.contrastCache.setColor(e.bg,e.fg,null);E=a;}var x={css:l.channels.toCss(E>>24&255,E>>16&255,E>>8&255),rgba:E};return s||a||this._colors.contrastCache.setColor(e.bg,e.fg,x),x}},e.prototype._resolveBackgroundRgba=function(e,t,r){switch(e){case 16777216:case 33554432:return this._colors.ansi[t].rgba;case 50331648:return t<<8;default:return r?this._colors.foreground.rgba:this._colors.background.rgba}},e.prototype._resolveForegroundRgba=function(e,t,r,i){switch(e){case 16777216:case 33554432:return this._optionsService.rawOptions.drawBoldTextInBrightColors&&i&&t<8&&(t+=8),this._colors.ansi[t].rgba;case 50331648:return t<<8;default:return r?this._colors.background.rgba:this._colors.foreground.rgba}},e.prototype._isCellInSelection=function(e,t){var r=this._selectionStart,i=this._selectionEnd;return !(!r||!i)&&(this._columnSelectMode?e>=r[0]&&t>=r[1]&&e<i[0]&&t<i[1]:t>r[1]&&t<i[1]||r[1]===i[1]&&t===r[1]&&e>=r[0]&&e<i[0]||r[1]<i[1]&&t===i[1]&&e<i[0]||r[1]<i[1]&&t===r[1]&&e>=r[0])},e}();t.BaseRenderLayer=f;},2512:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.CursorRenderLayer=void 0;var a=r(1546),c=r(511),l=r(2585),h=r(4725),u=600,f=function(e){function t(t,r,i,n,o,s,a,l,h,u){var f=e.call(this,t,"cursor",r,!0,i,n,s,a,u)||this;return f._onRequestRedraw=o,f._coreService=l,f._coreBrowserService=h,f._cell=new c.CellData,f._state={x:0,y:0,isFocused:!1,style:"",width:0},f._cursorRenderers={bar:f._renderBarCursor.bind(f),block:f._renderBlockCursor.bind(f),underline:f._renderUnderlineCursor.bind(f)},f}return n(t,e),t.prototype.dispose=function(){this._cursorBlinkStateManager&&(this._cursorBlinkStateManager.dispose(),this._cursorBlinkStateManager=void 0),e.prototype.dispose.call(this);},t.prototype.resize=function(t){e.prototype.resize.call(this,t),this._state={x:0,y:0,isFocused:!1,style:"",width:0};},t.prototype.reset=function(){var e;this._clearCursor(),null===(e=this._cursorBlinkStateManager)||void 0===e||e.restartBlinkAnimation(),this.onOptionsChanged();},t.prototype.onBlur=function(){var e;null===(e=this._cursorBlinkStateManager)||void 0===e||e.pause(),this._onRequestRedraw.fire({start:this._bufferService.buffer.y,end:this._bufferService.buffer.y});},t.prototype.onFocus=function(){var e;null===(e=this._cursorBlinkStateManager)||void 0===e||e.resume(),this._onRequestRedraw.fire({start:this._bufferService.buffer.y,end:this._bufferService.buffer.y});},t.prototype.onOptionsChanged=function(){var e,t=this;this._optionsService.rawOptions.cursorBlink?this._cursorBlinkStateManager||(this._cursorBlinkStateManager=new _(this._coreBrowserService.isFocused,(function(){t._render(!0);}))):(null===(e=this._cursorBlinkStateManager)||void 0===e||e.dispose(),this._cursorBlinkStateManager=void 0),this._onRequestRedraw.fire({start:this._bufferService.buffer.y,end:this._bufferService.buffer.y});},t.prototype.onCursorMove=function(){var e;null===(e=this._cursorBlinkStateManager)||void 0===e||e.restartBlinkAnimation();},t.prototype.onGridChanged=function(e,t){!this._cursorBlinkStateManager||this._cursorBlinkStateManager.isPaused?this._render(!1):this._cursorBlinkStateManager.restartBlinkAnimation();},t.prototype._render=function(e){if(this._coreService.isCursorInitialized&&!this._coreService.isCursorHidden){var t=this._bufferService.buffer.ybase+this._bufferService.buffer.y,r=t-this._bufferService.buffer.ydisp;if(r<0||r>=this._bufferService.rows)this._clearCursor();else {var i=Math.min(this._bufferService.buffer.x,this._bufferService.cols-1);if(this._bufferService.buffer.lines.get(t).loadCell(i,this._cell),void 0!==this._cell.content){if(!this._coreBrowserService.isFocused){this._clearCursor(),this._ctx.save(),this._ctx.fillStyle=this._colors.cursor.css;var n=this._optionsService.rawOptions.cursorStyle;return n&&"block"!==n?this._cursorRenderers[n](i,r,this._cell):this._renderBlurCursor(i,r,this._cell),this._ctx.restore(),this._state.x=i,this._state.y=r,this._state.isFocused=!1,this._state.style=n,void(this._state.width=this._cell.getWidth())}if(!this._cursorBlinkStateManager||this._cursorBlinkStateManager.isCursorVisible){if(this._state){if(this._state.x===i&&this._state.y===r&&this._state.isFocused===this._coreBrowserService.isFocused&&this._state.style===this._optionsService.rawOptions.cursorStyle&&this._state.width===this._cell.getWidth())return;this._clearCursor();}this._ctx.save(),this._cursorRenderers[this._optionsService.rawOptions.cursorStyle||"block"](i,r,this._cell),this._ctx.restore(),this._state.x=i,this._state.y=r,this._state.isFocused=!1,this._state.style=this._optionsService.rawOptions.cursorStyle,this._state.width=this._cell.getWidth();}else this._clearCursor();}}}else this._clearCursor();},t.prototype._clearCursor=function(){this._state&&(window.devicePixelRatio<1?this._clearAll():this._clearCells(this._state.x,this._state.y,this._state.width,1),this._state={x:0,y:0,isFocused:!1,style:"",width:0});},t.prototype._renderBarCursor=function(e,t,r){this._ctx.save(),this._ctx.fillStyle=this._colors.cursor.css,this._fillLeftLineAtCell(e,t,this._optionsService.rawOptions.cursorWidth),this._ctx.restore();},t.prototype._renderBlockCursor=function(e,t,r){this._ctx.save(),this._ctx.fillStyle=this._colors.cursor.css,this._fillCells(e,t,r.getWidth(),1),this._ctx.fillStyle=this._colors.cursorAccent.css,this._fillCharTrueColor(r,e,t),this._ctx.restore();},t.prototype._renderUnderlineCursor=function(e,t,r){this._ctx.save(),this._ctx.fillStyle=this._colors.cursor.css,this._fillBottomLineAtCells(e,t),this._ctx.restore();},t.prototype._renderBlurCursor=function(e,t,r){this._ctx.save(),this._ctx.strokeStyle=this._colors.cursor.css,this._strokeRectAtCell(e,t,r.getWidth(),1),this._ctx.restore();},o([s(5,l.IBufferService),s(6,l.IOptionsService),s(7,l.ICoreService),s(8,h.ICoreBrowserService),s(9,l.IDecorationService)],t)}(a.BaseRenderLayer);t.CursorRenderLayer=f;var _=function(){function e(e,t){this._renderCallback=t,this.isCursorVisible=!0,e&&this._restartInterval();}return Object.defineProperty(e.prototype,"isPaused",{get:function(){return !(this._blinkStartTimeout||this._blinkInterval)},enumerable:!1,configurable:!0}),e.prototype.dispose=function(){this._blinkInterval&&(window.clearInterval(this._blinkInterval),this._blinkInterval=void 0),this._blinkStartTimeout&&(window.clearTimeout(this._blinkStartTimeout),this._blinkStartTimeout=void 0),this._animationFrame&&(window.cancelAnimationFrame(this._animationFrame),this._animationFrame=void 0);},e.prototype.restartBlinkAnimation=function(){var e=this;this.isPaused||(this._animationTimeRestarted=Date.now(),this.isCursorVisible=!0,this._animationFrame||(this._animationFrame=window.requestAnimationFrame((function(){e._renderCallback(),e._animationFrame=void 0;}))));},e.prototype._restartInterval=function(e){var t=this;void 0===e&&(e=u),this._blinkInterval&&(window.clearInterval(this._blinkInterval),this._blinkInterval=void 0),this._blinkStartTimeout=window.setTimeout((function(){if(t._animationTimeRestarted){var e=u-(Date.now()-t._animationTimeRestarted);if(t._animationTimeRestarted=void 0,e>0)return void t._restartInterval(e)}t.isCursorVisible=!1,t._animationFrame=window.requestAnimationFrame((function(){t._renderCallback(),t._animationFrame=void 0;})),t._blinkInterval=window.setInterval((function(){if(t._animationTimeRestarted){var e=u-(Date.now()-t._animationTimeRestarted);return t._animationTimeRestarted=void 0,void t._restartInterval(e)}t.isCursorVisible=!t.isCursorVisible,t._animationFrame=window.requestAnimationFrame((function(){t._renderCallback(),t._animationFrame=void 0;}));}),u);}),e);},e.prototype.pause=function(){this.isCursorVisible=!0,this._blinkInterval&&(window.clearInterval(this._blinkInterval),this._blinkInterval=void 0),this._blinkStartTimeout&&(window.clearTimeout(this._blinkStartTimeout),this._blinkStartTimeout=void 0),this._animationFrame&&(window.cancelAnimationFrame(this._animationFrame),this._animationFrame=void 0);},e.prototype.resume=function(){this.pause(),this._animationTimeRestarted=void 0,this._restartInterval(),this.restartBlinkAnimation();},e}();},8978:function(e,t,r){var i,n,o,s,a,c,l,h,u,f,_,d,p,v,y,g,m,b,S,C,w,L,E,x,R,k,M,A,O,D,T,B,P,I,H,j,F,W,U,q,N,z,K,G,V,X,Z,Y,J,$,Q,ee,te,re,ie,ne,oe,se,ae,ce,le,he,ue,fe,_e,de,pe,ve,ye,ge,me,be,Se,Ce,we,Le,Ee,xe,Re,ke,Me,Ae,Oe,De,Te,Be,Pe,Ie,He,je,Fe,We,Ue,qe,Ne,ze,Ke,Ge,Ve,Xe,Ze,Ye,Je,$e,Qe,et,tt,rt,it,nt,ot,st,at,ct,lt,ht,ut,ft,_t,dt,pt,vt,yt,gt,mt,bt,St,Ct,wt=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s},Lt=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.tryDrawCustomChar=t.powerlineDefinitions=t.boxDrawingDefinitions=t.blockElementDefinitions=void 0;var Et=r(1752);t.blockElementDefinitions={"▀":[{x:0,y:0,w:8,h:4}],"▁":[{x:0,y:7,w:8,h:1}],"▂":[{x:0,y:6,w:8,h:2}],"▃":[{x:0,y:5,w:8,h:3}],"▄":[{x:0,y:4,w:8,h:4}],"▅":[{x:0,y:3,w:8,h:5}],"▆":[{x:0,y:2,w:8,h:6}],"▇":[{x:0,y:1,w:8,h:7}],"█":[{x:0,y:0,w:8,h:8}],"▉":[{x:0,y:0,w:7,h:8}],"▊":[{x:0,y:0,w:6,h:8}],"▋":[{x:0,y:0,w:5,h:8}],"▌":[{x:0,y:0,w:4,h:8}],"▍":[{x:0,y:0,w:3,h:8}],"▎":[{x:0,y:0,w:2,h:8}],"▏":[{x:0,y:0,w:1,h:8}],"▐":[{x:4,y:0,w:4,h:8}],"▔":[{x:0,y:0,w:9,h:1}],"▕":[{x:7,y:0,w:1,h:8}],"▖":[{x:0,y:4,w:4,h:4}],"▗":[{x:4,y:4,w:4,h:4}],"▘":[{x:0,y:0,w:4,h:4}],"▙":[{x:0,y:0,w:4,h:8},{x:0,y:4,w:8,h:4}],"▚":[{x:0,y:0,w:4,h:4},{x:4,y:4,w:4,h:4}],"▛":[{x:0,y:0,w:4,h:8},{x:0,y:0,w:4,h:8}],"▜":[{x:0,y:0,w:8,h:4},{x:4,y:0,w:4,h:8}],"▝":[{x:4,y:0,w:4,h:4}],"▞":[{x:4,y:0,w:4,h:4},{x:0,y:4,w:4,h:4}],"▟":[{x:4,y:0,w:4,h:8},{x:0,y:4,w:8,h:4}],"🭰":[{x:1,y:0,w:1,h:8}],"🭱":[{x:2,y:0,w:1,h:8}],"🭲":[{x:3,y:0,w:1,h:8}],"🭳":[{x:4,y:0,w:1,h:8}],"🭴":[{x:5,y:0,w:1,h:8}],"🭵":[{x:6,y:0,w:1,h:8}],"🭶":[{x:0,y:1,w:8,h:1}],"🭷":[{x:0,y:2,w:8,h:1}],"🭸":[{x:0,y:3,w:8,h:1}],"🭹":[{x:0,y:4,w:8,h:1}],"🭺":[{x:0,y:5,w:8,h:1}],"🭻":[{x:0,y:6,w:8,h:1}],"🭼":[{x:0,y:0,w:1,h:8},{x:0,y:7,w:8,h:1}],"🭽":[{x:0,y:0,w:1,h:8},{x:0,y:0,w:8,h:1}],"🭾":[{x:7,y:0,w:1,h:8},{x:0,y:0,w:8,h:1}],"🭿":[{x:7,y:0,w:1,h:8},{x:0,y:7,w:8,h:1}],"🮀":[{x:0,y:0,w:8,h:1},{x:0,y:7,w:8,h:1}],"🮁":[{x:0,y:0,w:8,h:1},{x:0,y:2,w:8,h:1},{x:0,y:4,w:8,h:1},{x:0,y:7,w:8,h:1}],"🮂":[{x:0,y:0,w:8,h:2}],"🮃":[{x:0,y:0,w:8,h:3}],"🮄":[{x:0,y:0,w:8,h:5}],"🮅":[{x:0,y:0,w:8,h:6}],"🮆":[{x:0,y:0,w:8,h:7}],"🮇":[{x:6,y:0,w:2,h:8}],"🮈":[{x:5,y:0,w:3,h:8}],"🮉":[{x:3,y:0,w:5,h:8}],"🮊":[{x:2,y:0,w:6,h:8}],"🮋":[{x:1,y:0,w:7,h:8}],"🮕":[{x:0,y:0,w:2,h:2},{x:4,y:0,w:2,h:2},{x:2,y:2,w:2,h:2},{x:6,y:2,w:2,h:2},{x:0,y:4,w:2,h:2},{x:4,y:4,w:2,h:2},{x:2,y:6,w:2,h:2},{x:6,y:6,w:2,h:2}],"🮖":[{x:2,y:0,w:2,h:2},{x:6,y:0,w:2,h:2},{x:0,y:2,w:2,h:2},{x:4,y:2,w:2,h:2},{x:2,y:4,w:2,h:2},{x:6,y:4,w:2,h:2},{x:0,y:6,w:2,h:2},{x:4,y:6,w:2,h:2}],"🮗":[{x:0,y:2,w:8,h:2},{x:0,y:6,w:8,h:2}]};var xt={"░":[[1,0,0,0],[0,0,0,0],[0,0,1,0],[0,0,0,0]],"▒":[[1,0],[0,0],[0,1],[0,0]],"▓":[[0,1],[1,1],[1,0],[1,1]]};t.boxDrawingDefinitions={"─":(i={},i[1]="M0,.5 L1,.5",i),"━":(n={},n[3]="M0,.5 L1,.5",n),"│":(o={},o[1]="M.5,0 L.5,1",o),"┃":(s={},s[3]="M.5,0 L.5,1",s),"┌":(a={},a[1]="M0.5,1 L.5,.5 L1,.5",a),"┏":(c={},c[3]="M0.5,1 L.5,.5 L1,.5",c),"┐":(l={},l[1]="M0,.5 L.5,.5 L.5,1",l),"┓":(h={},h[3]="M0,.5 L.5,.5 L.5,1",h),"└":(u={},u[1]="M.5,0 L.5,.5 L1,.5",u),"┗":(f={},f[3]="M.5,0 L.5,.5 L1,.5",f),"┘":(_={},_[1]="M.5,0 L.5,.5 L0,.5",_),"┛":(d={},d[3]="M.5,0 L.5,.5 L0,.5",d),"├":(p={},p[1]="M.5,0 L.5,1 M.5,.5 L1,.5",p),"┣":(v={},v[3]="M.5,0 L.5,1 M.5,.5 L1,.5",v),"┤":(y={},y[1]="M.5,0 L.5,1 M.5,.5 L0,.5",y),"┫":(g={},g[3]="M.5,0 L.5,1 M.5,.5 L0,.5",g),"┬":(m={},m[1]="M0,.5 L1,.5 M.5,.5 L.5,1",m),"┳":(b={},b[3]="M0,.5 L1,.5 M.5,.5 L.5,1",b),"┴":(S={},S[1]="M0,.5 L1,.5 M.5,.5 L.5,0",S),"┻":(C={},C[3]="M0,.5 L1,.5 M.5,.5 L.5,0",C),"┼":(w={},w[1]="M0,.5 L1,.5 M.5,0 L.5,1",w),"╋":(L={},L[3]="M0,.5 L1,.5 M.5,0 L.5,1",L),"╴":(E={},E[1]="M.5,.5 L0,.5",E),"╸":(x={},x[3]="M.5,.5 L0,.5",x),"╵":(R={},R[1]="M.5,.5 L.5,0",R),"╹":(k={},k[3]="M.5,.5 L.5,0",k),"╶":(M={},M[1]="M.5,.5 L1,.5",M),"╺":(A={},A[3]="M.5,.5 L1,.5",A),"╷":(O={},O[1]="M.5,.5 L.5,1",O),"╻":(D={},D[3]="M.5,.5 L.5,1",D),"═":(T={},T[1]=function(e,t){return "M0,"+(.5-t)+" L1,"+(.5-t)+" M0,"+(.5+t)+" L1,"+(.5+t)},T),"║":(B={},B[1]=function(e,t){return "M"+(.5-e)+",0 L"+(.5-e)+",1 M"+(.5+e)+",0 L"+(.5+e)+",1"},B),"╒":(P={},P[1]=function(e,t){return "M.5,1 L.5,"+(.5-t)+" L1,"+(.5-t)+" M.5,"+(.5+t)+" L1,"+(.5+t)},P),"╓":(I={},I[1]=function(e,t){return "M"+(.5-e)+",1 L"+(.5-e)+",.5 L1,.5 M"+(.5+e)+",.5 L"+(.5+e)+",1"},I),"╔":(H={},H[1]=function(e,t){return "M1,"+(.5-t)+" L"+(.5-e)+","+(.5-t)+" L"+(.5-e)+",1 M1,"+(.5+t)+" L"+(.5+e)+","+(.5+t)+" L"+(.5+e)+",1"},H),"╕":(j={},j[1]=function(e,t){return "M0,"+(.5-t)+" L.5,"+(.5-t)+" L.5,1 M0,"+(.5+t)+" L.5,"+(.5+t)},j),"╖":(F={},F[1]=function(e,t){return "M"+(.5+e)+",1 L"+(.5+e)+",.5 L0,.5 M"+(.5-e)+",.5 L"+(.5-e)+",1"},F),"╗":(W={},W[1]=function(e,t){return "M0,"+(.5+t)+" L"+(.5-e)+","+(.5+t)+" L"+(.5-e)+",1 M0,"+(.5-t)+" L"+(.5+e)+","+(.5-t)+" L"+(.5+e)+",1"},W),"╘":(U={},U[1]=function(e,t){return "M.5,0 L.5,"+(.5+t)+" L1,"+(.5+t)+" M.5,"+(.5-t)+" L1,"+(.5-t)},U),"╙":(q={},q[1]=function(e,t){return "M1,.5 L"+(.5-e)+",.5 L"+(.5-e)+",0 M"+(.5+e)+",.5 L"+(.5+e)+",0"},q),"╚":(N={},N[1]=function(e,t){return "M1,"+(.5-t)+" L"+(.5+e)+","+(.5-t)+" L"+(.5+e)+",0 M1,"+(.5+t)+" L"+(.5-e)+","+(.5+t)+" L"+(.5-e)+",0"},N),"╛":(z={},z[1]=function(e,t){return "M0,"+(.5+t)+" L.5,"+(.5+t)+" L.5,0 M0,"+(.5-t)+" L.5,"+(.5-t)},z),"╜":(K={},K[1]=function(e,t){return "M0,.5 L"+(.5+e)+",.5 L"+(.5+e)+",0 M"+(.5-e)+",.5 L"+(.5-e)+",0"},K),"╝":(G={},G[1]=function(e,t){return "M0,"+(.5-t)+" L"+(.5-e)+","+(.5-t)+" L"+(.5-e)+",0 M0,"+(.5+t)+" L"+(.5+e)+","+(.5+t)+" L"+(.5+e)+",0"},G),"╞":(V={},V[1]=function(e,t){return "M.5,0 L.5,1 M.5,"+(.5-t)+" L1,"+(.5-t)+" M.5,"+(.5+t)+" L1,"+(.5+t)},V),"╟":(X={},X[1]=function(e,t){return "M"+(.5-e)+",0 L"+(.5-e)+",1 M"+(.5+e)+",0 L"+(.5+e)+",1 M"+(.5+e)+",.5 L1,.5"},X),"╠":(Z={},Z[1]=function(e,t){return "M"+(.5-e)+",0 L"+(.5-e)+",1 M1,"+(.5+t)+" L"+(.5+e)+","+(.5+t)+" L"+(.5+e)+",1 M1,"+(.5-t)+" L"+(.5+e)+","+(.5-t)+" L"+(.5+e)+",0"},Z),"╡":(Y={},Y[1]=function(e,t){return "M.5,0 L.5,1 M0,"+(.5-t)+" L.5,"+(.5-t)+" M0,"+(.5+t)+" L.5,"+(.5+t)},Y),"╢":(J={},J[1]=function(e,t){return "M0,.5 L"+(.5-e)+",.5 M"+(.5-e)+",0 L"+(.5-e)+",1 M"+(.5+e)+",0 L"+(.5+e)+",1"},J),"╣":($={},$[1]=function(e,t){return "M"+(.5+e)+",0 L"+(.5+e)+",1 M0,"+(.5+t)+" L"+(.5-e)+","+(.5+t)+" L"+(.5-e)+",1 M0,"+(.5-t)+" L"+(.5-e)+","+(.5-t)+" L"+(.5-e)+",0"},$),"╤":(Q={},Q[1]=function(e,t){return "M0,"+(.5-t)+" L1,"+(.5-t)+" M0,"+(.5+t)+" L1,"+(.5+t)+" M.5,"+(.5+t)+" L.5,1"},Q),"╥":(ee={},ee[1]=function(e,t){return "M0,.5 L1,.5 M"+(.5-e)+",.5 L"+(.5-e)+",1 M"+(.5+e)+",.5 L"+(.5+e)+",1"},ee),"╦":(te={},te[1]=function(e,t){return "M0,"+(.5-t)+" L1,"+(.5-t)+" M0,"+(.5+t)+" L"+(.5-e)+","+(.5+t)+" L"+(.5-e)+",1 M1,"+(.5+t)+" L"+(.5+e)+","+(.5+t)+" L"+(.5+e)+",1"},te),"╧":(re={},re[1]=function(e,t){return "M.5,0 L.5,"+(.5-t)+" M0,"+(.5-t)+" L1,"+(.5-t)+" M0,"+(.5+t)+" L1,"+(.5+t)},re),"╨":(ie={},ie[1]=function(e,t){return "M0,.5 L1,.5 M"+(.5-e)+",.5 L"+(.5-e)+",0 M"+(.5+e)+",.5 L"+(.5+e)+",0"},ie),"╩":(ne={},ne[1]=function(e,t){return "M0,"+(.5+t)+" L1,"+(.5+t)+" M0,"+(.5-t)+" L"+(.5-e)+","+(.5-t)+" L"+(.5-e)+",0 M1,"+(.5-t)+" L"+(.5+e)+","+(.5-t)+" L"+(.5+e)+",0"},ne),"╪":(oe={},oe[1]=function(e,t){return "M.5,0 L.5,1 M0,"+(.5-t)+" L1,"+(.5-t)+" M0,"+(.5+t)+" L1,"+(.5+t)},oe),"╫":(se={},se[1]=function(e,t){return "M0,.5 L1,.5 M"+(.5-e)+",0 L"+(.5-e)+",1 M"+(.5+e)+",0 L"+(.5+e)+",1"},se),"╬":(ae={},ae[1]=function(e,t){return "M0,"+(.5+t)+" L"+(.5-e)+","+(.5+t)+" L"+(.5-e)+",1 M1,"+(.5+t)+" L"+(.5+e)+","+(.5+t)+" L"+(.5+e)+",1 M0,"+(.5-t)+" L"+(.5-e)+","+(.5-t)+" L"+(.5-e)+",0 M1,"+(.5-t)+" L"+(.5+e)+","+(.5-t)+" L"+(.5+e)+",0"},ae),"╱":(ce={},ce[1]="M1,0 L0,1",ce),"╲":(le={},le[1]="M0,0 L1,1",le),"╳":(he={},he[1]="M1,0 L0,1 M0,0 L1,1",he),"╼":(ue={},ue[1]="M.5,.5 L0,.5",ue[3]="M.5,.5 L1,.5",ue),"╽":(fe={},fe[1]="M.5,.5 L.5,0",fe[3]="M.5,.5 L.5,1",fe),"╾":(_e={},_e[1]="M.5,.5 L1,.5",_e[3]="M.5,.5 L0,.5",_e),"╿":(de={},de[1]="M.5,.5 L.5,1",de[3]="M.5,.5 L.5,0",de),"┍":(pe={},pe[1]="M.5,.5 L.5,1",pe[3]="M.5,.5 L1,.5",pe),"┎":(ve={},ve[1]="M.5,.5 L1,.5",ve[3]="M.5,.5 L.5,1",ve),"┑":(ye={},ye[1]="M.5,.5 L.5,1",ye[3]="M.5,.5 L0,.5",ye),"┒":(ge={},ge[1]="M.5,.5 L0,.5",ge[3]="M.5,.5 L.5,1",ge),"┕":(me={},me[1]="M.5,.5 L.5,0",me[3]="M.5,.5 L1,.5",me),"┖":(be={},be[1]="M.5,.5 L1,.5",be[3]="M.5,.5 L.5,0",be),"┙":(Se={},Se[1]="M.5,.5 L.5,0",Se[3]="M.5,.5 L0,.5",Se),"┚":(Ce={},Ce[1]="M.5,.5 L0,.5",Ce[3]="M.5,.5 L.5,0",Ce),"┝":(we={},we[1]="M.5,0 L.5,1",we[3]="M.5,.5 L1,.5",we),"┞":(Le={},Le[1]="M0.5,1 L.5,.5 L1,.5",Le[3]="M.5,.5 L.5,0",Le),"┟":(Ee={},Ee[1]="M.5,0 L.5,.5 L1,.5",Ee[3]="M.5,.5 L.5,1",Ee),"┠":(xe={},xe[1]="M.5,.5 L1,.5",xe[3]="M.5,0 L.5,1",xe),"┡":(Re={},Re[1]="M.5,.5 L.5,1",Re[3]="M.5,0 L.5,.5 L1,.5",Re),"┢":(ke={},ke[1]="M.5,.5 L.5,0",ke[3]="M0.5,1 L.5,.5 L1,.5",ke),"┥":(Me={},Me[1]="M.5,0 L.5,1",Me[3]="M.5,.5 L0,.5",Me),"┦":(Ae={},Ae[1]="M0,.5 L.5,.5 L.5,1",Ae[3]="M.5,.5 L.5,0",Ae),"┧":(Oe={},Oe[1]="M.5,0 L.5,.5 L0,.5",Oe[3]="M.5,.5 L.5,1",Oe),"┨":(De={},De[1]="M.5,.5 L0,.5",De[3]="M.5,0 L.5,1",De),"┩":(Te={},Te[1]="M.5,.5 L.5,1",Te[3]="M.5,0 L.5,.5 L0,.5",Te),"┪":(Be={},Be[1]="M.5,.5 L.5,0",Be[3]="M0,.5 L.5,.5 L.5,1",Be),"┭":(Pe={},Pe[1]="M0.5,1 L.5,.5 L1,.5",Pe[3]="M.5,.5 L0,.5",Pe),"┮":(Ie={},Ie[1]="M0,.5 L.5,.5 L.5,1",Ie[3]="M.5,.5 L1,.5",Ie),"┯":(He={},He[1]="M.5,.5 L.5,1",He[3]="M0,.5 L1,.5",He),"┰":(je={},je[1]="M0,.5 L1,.5",je[3]="M.5,.5 L.5,1",je),"┱":(Fe={},Fe[1]="M.5,.5 L1,.5",Fe[3]="M0,.5 L.5,.5 L.5,1",Fe),"┲":(We={},We[1]="M.5,.5 L0,.5",We[3]="M0.5,1 L.5,.5 L1,.5",We),"┵":(Ue={},Ue[1]="M.5,0 L.5,.5 L1,.5",Ue[3]="M.5,.5 L0,.5",Ue),"┶":(qe={},qe[1]="M.5,0 L.5,.5 L0,.5",qe[3]="M.5,.5 L1,.5",qe),"┷":(Ne={},Ne[1]="M.5,.5 L.5,0",Ne[3]="M0,.5 L1,.5",Ne),"┸":(ze={},ze[1]="M0,.5 L1,.5",ze[3]="M.5,.5 L.5,0",ze),"┹":(Ke={},Ke[1]="M.5,.5 L1,.5",Ke[3]="M.5,0 L.5,.5 L0,.5",Ke),"┺":(Ge={},Ge[1]="M.5,.5 L0,.5",Ge[3]="M.5,0 L.5,.5 L1,.5",Ge),"┽":(Ve={},Ve[1]="M.5,0 L.5,1 M.5,.5 L1,.5",Ve[3]="M.5,.5 L0,.5",Ve),"┾":(Xe={},Xe[1]="M.5,0 L.5,1 M.5,.5 L0,.5",Xe[3]="M.5,.5 L1,.5",Xe),"┿":(Ze={},Ze[1]="M.5,0 L.5,1",Ze[3]="M0,.5 L1,.5",Ze),"╀":(Ye={},Ye[1]="M0,.5 L1,.5 M.5,.5 L.5,1",Ye[3]="M.5,.5 L.5,0",Ye),"╁":(Je={},Je[1]="M.5,.5 L.5,0 M0,.5 L1,.5",Je[3]="M.5,.5 L.5,1",Je),"╂":($e={},$e[1]="M0,.5 L1,.5",$e[3]="M.5,0 L.5,1",$e),"╃":(Qe={},Qe[1]="M0.5,1 L.5,.5 L1,.5",Qe[3]="M.5,0 L.5,.5 L0,.5",Qe),"╄":(et={},et[1]="M0,.5 L.5,.5 L.5,1",et[3]="M.5,0 L.5,.5 L1,.5",et),"╅":(tt={},tt[1]="M.5,0 L.5,.5 L1,.5",tt[3]="M0,.5 L.5,.5 L.5,1",tt),"╆":(rt={},rt[1]="M.5,0 L.5,.5 L0,.5",rt[3]="M0.5,1 L.5,.5 L1,.5",rt),"╇":(it={},it[1]="M.5,.5 L.5,1",it[3]="M.5,.5 L.5,0 M0,.5 L1,.5",it),"╈":(nt={},nt[1]="M.5,.5 L.5,0",nt[3]="M0,.5 L1,.5 M.5,.5 L.5,1",nt),"╉":(ot={},ot[1]="M.5,.5 L1,.5",ot[3]="M.5,0 L.5,1 M.5,.5 L0,.5",ot),"╊":(st={},st[1]="M.5,.5 L0,.5",st[3]="M.5,0 L.5,1 M.5,.5 L1,.5",st),"╌":(at={},at[1]="M.1,.5 L.4,.5 M.6,.5 L.9,.5",at),"╍":(ct={},ct[3]="M.1,.5 L.4,.5 M.6,.5 L.9,.5",ct),"┄":(lt={},lt[1]="M.0667,.5 L.2667,.5 M.4,.5 L.6,.5 M.7333,.5 L.9333,.5",lt),"┅":(ht={},ht[3]="M.0667,.5 L.2667,.5 M.4,.5 L.6,.5 M.7333,.5 L.9333,.5",ht),"┈":(ut={},ut[1]="M.05,.5 L.2,.5 M.3,.5 L.45,.5 M.55,.5 L.7,.5 M.8,.5 L.95,.5",ut),"┉":(ft={},ft[3]="M.05,.5 L.2,.5 M.3,.5 L.45,.5 M.55,.5 L.7,.5 M.8,.5 L.95,.5",ft),"╎":(_t={},_t[1]="M.5,.1 L.5,.4 M.5,.6 L.5,.9",_t),"╏":(dt={},dt[3]="M.5,.1 L.5,.4 M.5,.6 L.5,.9",dt),"┆":(pt={},pt[1]="M.5,.0667 L.5,.2667 M.5,.4 L.5,.6 M.5,.7333 L.5,.9333",pt),"┇":(vt={},vt[3]="M.5,.0667 L.5,.2667 M.5,.4 L.5,.6 M.5,.7333 L.5,.9333",vt),"┊":(yt={},yt[1]="M.5,.05 L.5,.2 M.5,.3 L.5,.45 L.5,.55 M.5,.7 L.5,.95",yt),"┋":(gt={},gt[3]="M.5,.05 L.5,.2 M.5,.3 L.5,.45 L.5,.55 M.5,.7 L.5,.95",gt),"╭":(mt={},mt[1]="C.5,1,.5,.5,1,.5",mt),"╮":(bt={},bt[1]="C.5,1,.5,.5,0,.5",bt),"╯":(St={},St[1]="C.5,0,.5,.5,0,.5",St),"╰":(Ct={},Ct[1]="C.5,0,.5,.5,1,.5",Ct)},t.powerlineDefinitions={"":{d:"M0,0 L1,.5 L0,1",type:0},"":{d:"M0,0 L1,.5 L0,1",type:1,horizontalPadding:.5},"":{d:"M1,0 L0,.5 L1,1",type:0},"":{d:"M1,0 L0,.5 L1,1",type:1,horizontalPadding:.5}},t.tryDrawCustomChar=function(e,r,i,n,o,s){var a=t.blockElementDefinitions[r];if(a)return function(e,t,r,i,n,o){for(var s=0;s<t.length;s++){var a=t[s],c=n/8,l=o/8;e.fillRect(r+a.x*c,i+a.y*l,a.w*c,a.h*l);}}(e,a,i,n,o,s),!0;var c=xt[r];if(c)return function(e,t,r,i,n,o){var s,a=Rt.get(t);a||(a=new Map,Rt.set(t,a));var c=e.fillStyle;if("string"!=typeof c)throw new Error('Unexpected fillStyle type "'+c+'"');var l=a.get(c);if(!l){var h=t[0].length,u=t.length,f=document.createElement("canvas");f.width=h,f.height=u;var _=(0, Et.throwIfFalsy)(f.getContext("2d")),d=new ImageData(h,u),p=void 0,v=void 0,y=void 0,g=void 0;if(c.startsWith("#"))p=parseInt(c.slice(1,3),16),v=parseInt(c.slice(3,5),16),y=parseInt(c.slice(5,7),16),g=c.length>7&&parseInt(c.slice(7,9),16)||1;else {if(!c.startsWith("rgba"))throw new Error('Unexpected fillStyle color format "'+c+'" when drawing pattern glyph');p=(s=wt(c.substring(5,c.length-1).split(",").map((function(e){return parseFloat(e)})),4))[0],v=s[1],y=s[2],g=s[3];}for(var m=0;m<u;m++)for(var b=0;b<h;b++)d.data[4*(m*h+b)]=p,d.data[4*(m*h+b)+1]=v,d.data[4*(m*h+b)+2]=y,d.data[4*(m*h+b)+3]=t[m][b]*(255*g);_.putImageData(d,0,0),l=(0, Et.throwIfFalsy)(e.createPattern(f,null)),a.set(c,l);}e.fillStyle=l,e.fillRect(r,i,n,o);}(e,c,i,n,o,s),!0;var l=t.boxDrawingDefinitions[r];if(l)return function(e,t,r,i,n,o){var s,a,c,l;e.strokeStyle=e.fillStyle;try{for(var h=Lt(Object.entries(t)),u=h.next();!u.done;u=h.next()){var f=wt(u.value,2),_=f[0],d=f[1];e.beginPath(),e.lineWidth=window.devicePixelRatio*Number.parseInt(_);var p=void 0;p="function"==typeof d?d(.15,.15/o*n):d;try{for(var v=(c=void 0,Lt(p.split(" "))),y=v.next();!y.done;y=v.next()){var g=y.value,m=g[0],b=Mt[m];if(b){var S=g.substring(1).split(",");S[0]&&S[1]&&b(e,At(S,n,o,r,i));}else console.error('Could not find drawing instructions for "'+m+'"');}}catch(e){c={error:e};}finally{try{y&&!y.done&&(l=v.return)&&l.call(v);}finally{if(c)throw c.error}}e.stroke(),e.closePath();}}catch(e){s={error:e};}finally{try{u&&!u.done&&(a=h.return)&&a.call(h);}finally{if(s)throw s.error}}}(e,l,i,n,o,s),!0;var h=t.powerlineDefinitions[r];return !!h&&(function(e,t,r,i,n,o){var s,a;e.beginPath(),e.lineWidth=window.devicePixelRatio;try{for(var c=Lt(t.d.split(" ")),l=c.next();!l.done;l=c.next()){var h=l.value,u=h[0],f=Mt[u];if(f){var _=h.substring(1).split(",");_[0]&&_[1]&&f(e,At(_,n,o,r,i,t.horizontalPadding));}else console.error('Could not find drawing instructions for "'+u+'"');}}catch(e){s={error:e};}finally{try{l&&!l.done&&(a=c.return)&&a.call(c);}finally{if(s)throw s.error}}1===t.type?(e.strokeStyle=e.fillStyle,e.stroke()):e.fill(),e.closePath();}(e,h,i,n,o,s),!0)};var Rt=new Map;function kt(e,t,r){return void 0===r&&(r=0),Math.max(Math.min(e,t),r)}var Mt={C:function(e,t){return e.bezierCurveTo(t[0],t[1],t[2],t[3],t[4],t[5])},L:function(e,t){return e.lineTo(t[0],t[1])},M:function(e,t){return e.moveTo(t[0],t[1])}};function At(e,t,r,i,n,o){void 0===o&&(o=0);var s=e.map((function(e){return parseFloat(e)||parseInt(e)}));if(s.length<2)throw new Error("Too few arguments for instruction");for(var a=0;a<s.length;a+=2)s[a]*=t-2*o*window.devicePixelRatio,0!==s[a]&&(s[a]=kt(Math.round(s[a]+.5)-.5,t,0)),s[a]+=i+o*window.devicePixelRatio;for(var c=1;c<s.length;c+=2)s[c]*=r,0!==s[c]&&(s[c]=kt(Math.round(s[c]+.5)-.5,r,0)),s[c]+=n;return s}},3700:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.GridCache=void 0;var r=function(){function e(){this.cache=[];}return e.prototype.resize=function(e,t){for(var r=0;r<e;r++){this.cache.length<=r&&this.cache.push([]);for(var i=this.cache[r].length;i<t;i++)this.cache[r].push(void 0);this.cache[r].length=t;}this.cache.length=e;},e.prototype.clear=function(){for(var e=0;e<this.cache.length;e++)for(var t=0;t<this.cache[e].length;t++)this.cache[e][t]=void 0;},e}();t.GridCache=r;},5098:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.LinkRenderLayer=void 0;var a=r(1546),c=r(8803),l=r(2040),h=r(2585),u=function(e){function t(t,r,i,n,o,s,a,c,l){var h=e.call(this,t,"link",r,!0,i,n,a,c,l)||this;return o.onShowLinkUnderline((function(e){return h._onShowLinkUnderline(e)})),o.onHideLinkUnderline((function(e){return h._onHideLinkUnderline(e)})),s.onShowLinkUnderline((function(e){return h._onShowLinkUnderline(e)})),s.onHideLinkUnderline((function(e){return h._onHideLinkUnderline(e)})),h}return n(t,e),t.prototype.resize=function(t){e.prototype.resize.call(this,t),this._state=void 0;},t.prototype.reset=function(){this._clearCurrentLink();},t.prototype._clearCurrentLink=function(){if(this._state){this._clearCells(this._state.x1,this._state.y1,this._state.cols-this._state.x1,1);var e=this._state.y2-this._state.y1-1;e>0&&this._clearCells(0,this._state.y1+1,this._state.cols,e),this._clearCells(0,this._state.y2,this._state.x2,1),this._state=void 0;}},t.prototype._onShowLinkUnderline=function(e){if(e.fg===c.INVERTED_DEFAULT_COLOR?this._ctx.fillStyle=this._colors.background.css:e.fg&&(0, l.is256Color)(e.fg)?this._ctx.fillStyle=this._colors.ansi[e.fg].css:this._ctx.fillStyle=this._colors.foreground.css,e.y1===e.y2)this._fillBottomLineAtCells(e.x1,e.y1,e.x2-e.x1);else {this._fillBottomLineAtCells(e.x1,e.y1,e.cols-e.x1);for(var t=e.y1+1;t<e.y2;t++)this._fillBottomLineAtCells(0,t,e.cols);this._fillBottomLineAtCells(0,e.y2,e.x2);}this._state=e;},t.prototype._onHideLinkUnderline=function(e){this._clearCurrentLink();},o([s(6,h.IBufferService),s(7,h.IOptionsService),s(8,h.IDecorationService)],t)}(a.BaseRenderLayer);t.LinkRenderLayer=u;},3525:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},a=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.Renderer=void 0;var c=r(9596),l=r(4149),h=r(2512),u=r(5098),f=r(844),_=r(4725),d=r(2585),p=r(1420),v=r(8460),y=1,g=function(e){function t(t,r,i,n,o,s,a,f){var _=e.call(this)||this;_._colors=t,_._screenElement=r,_._bufferService=s,_._charSizeService=a,_._optionsService=f,_._id=y++,_._onRequestRedraw=new v.EventEmitter;var d=_._optionsService.rawOptions.allowTransparency;return _._renderLayers=[o.createInstance(c.TextRenderLayer,_._screenElement,0,_._colors,d,_._id),o.createInstance(l.SelectionRenderLayer,_._screenElement,1,_._colors,_._id),o.createInstance(u.LinkRenderLayer,_._screenElement,2,_._colors,_._id,i,n),o.createInstance(h.CursorRenderLayer,_._screenElement,3,_._colors,_._id,_._onRequestRedraw)],_.dimensions={scaledCharWidth:0,scaledCharHeight:0,scaledCellWidth:0,scaledCellHeight:0,scaledCharLeft:0,scaledCharTop:0,scaledCanvasWidth:0,scaledCanvasHeight:0,canvasWidth:0,canvasHeight:0,actualCellWidth:0,actualCellHeight:0},_._devicePixelRatio=window.devicePixelRatio,_._updateDimensions(),_.onOptionsChanged(),_}return n(t,e),Object.defineProperty(t.prototype,"onRequestRedraw",{get:function(){return this._onRequestRedraw.event},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){var t,r;try{for(var i=a(this._renderLayers),n=i.next();!n.done;n=i.next())n.value.dispose();}catch(e){t={error:e};}finally{try{n&&!n.done&&(r=i.return)&&r.call(i);}finally{if(t)throw t.error}}e.prototype.dispose.call(this),(0, p.removeTerminalFromCache)(this._id);},t.prototype.onDevicePixelRatioChange=function(){this._devicePixelRatio!==window.devicePixelRatio&&(this._devicePixelRatio=window.devicePixelRatio,this.onResize(this._bufferService.cols,this._bufferService.rows));},t.prototype.setColors=function(e){var t,r;this._colors=e;try{for(var i=a(this._renderLayers),n=i.next();!n.done;n=i.next()){var o=n.value;o.setColors(this._colors),o.reset();}}catch(e){t={error:e};}finally{try{n&&!n.done&&(r=i.return)&&r.call(i);}finally{if(t)throw t.error}}},t.prototype.onResize=function(e,t){var r,i;this._updateDimensions();try{for(var n=a(this._renderLayers),o=n.next();!o.done;o=n.next())o.value.resize(this.dimensions);}catch(e){r={error:e};}finally{try{o&&!o.done&&(i=n.return)&&i.call(n);}finally{if(r)throw r.error}}this._screenElement.style.width=this.dimensions.canvasWidth+"px",this._screenElement.style.height=this.dimensions.canvasHeight+"px";},t.prototype.onCharSizeChanged=function(){this.onResize(this._bufferService.cols,this._bufferService.rows);},t.prototype.onBlur=function(){this._runOperation((function(e){return e.onBlur()}));},t.prototype.onFocus=function(){this._runOperation((function(e){return e.onFocus()}));},t.prototype.onSelectionChanged=function(e,t,r){void 0===r&&(r=!1),this._runOperation((function(i){return i.onSelectionChanged(e,t,r)})),this._colors.selectionForeground&&this._onRequestRedraw.fire({start:0,end:this._bufferService.rows-1});},t.prototype.onCursorMove=function(){this._runOperation((function(e){return e.onCursorMove()}));},t.prototype.onOptionsChanged=function(){this._runOperation((function(e){return e.onOptionsChanged()}));},t.prototype.clear=function(){this._runOperation((function(e){return e.reset()}));},t.prototype._runOperation=function(e){var t,r;try{for(var i=a(this._renderLayers),n=i.next();!n.done;n=i.next())e(n.value);}catch(e){t={error:e};}finally{try{n&&!n.done&&(r=i.return)&&r.call(i);}finally{if(t)throw t.error}}},t.prototype.renderRows=function(e,t){var r,i;try{for(var n=a(this._renderLayers),o=n.next();!o.done;o=n.next())o.value.onGridChanged(e,t);}catch(e){r={error:e};}finally{try{o&&!o.done&&(i=n.return)&&i.call(n);}finally{if(r)throw r.error}}},t.prototype.clearTextureAtlas=function(){var e,t;try{for(var r=a(this._renderLayers),i=r.next();!i.done;i=r.next())i.value.clearTextureAtlas();}catch(t){e={error:t};}finally{try{i&&!i.done&&(t=r.return)&&t.call(r);}finally{if(e)throw e.error}}},t.prototype._updateDimensions=function(){this._charSizeService.hasValidSize&&(this.dimensions.scaledCharWidth=Math.floor(this._charSizeService.width*window.devicePixelRatio),this.dimensions.scaledCharHeight=Math.ceil(this._charSizeService.height*window.devicePixelRatio),this.dimensions.scaledCellHeight=Math.floor(this.dimensions.scaledCharHeight*this._optionsService.rawOptions.lineHeight),this.dimensions.scaledCharTop=1===this._optionsService.rawOptions.lineHeight?0:Math.round((this.dimensions.scaledCellHeight-this.dimensions.scaledCharHeight)/2),this.dimensions.scaledCellWidth=this.dimensions.scaledCharWidth+Math.round(this._optionsService.rawOptions.letterSpacing),this.dimensions.scaledCharLeft=Math.floor(this._optionsService.rawOptions.letterSpacing/2),this.dimensions.scaledCanvasHeight=this._bufferService.rows*this.dimensions.scaledCellHeight,this.dimensions.scaledCanvasWidth=this._bufferService.cols*this.dimensions.scaledCellWidth,this.dimensions.canvasHeight=Math.round(this.dimensions.scaledCanvasHeight/window.devicePixelRatio),this.dimensions.canvasWidth=Math.round(this.dimensions.scaledCanvasWidth/window.devicePixelRatio),this.dimensions.actualCellHeight=this.dimensions.canvasHeight/this._bufferService.rows,this.dimensions.actualCellWidth=this.dimensions.canvasWidth/this._bufferService.cols);},o([s(4,d.IInstantiationService),s(5,d.IBufferService),s(6,_.ICharSizeService),s(7,d.IOptionsService)],t)}(f.Disposable);t.Renderer=g;},1752:(e,t)=>{function r(e){return 57508<=e&&e<=57558}Object.defineProperty(t,"__esModule",{value:!0}),t.excludeFromContrastRatioDemands=t.isPowerlineGlyph=t.throwIfFalsy=void 0,t.throwIfFalsy=function(e){if(!e)throw new Error("value must not be falsy");return e},t.isPowerlineGlyph=r,t.excludeFromContrastRatioDemands=function(e){return r(e)||function(e){return 9472<=e&&e<=9631}(e)};},4149:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.SelectionRenderLayer=void 0;var a=r(1546),c=r(2585),l=function(e){function t(t,r,i,n,o,s,a){var c=e.call(this,t,"selection",r,!0,i,n,o,s,a)||this;return c._clearState(),c}return n(t,e),t.prototype._clearState=function(){this._state={start:void 0,end:void 0,columnSelectMode:void 0,ydisp:void 0};},t.prototype.resize=function(t){e.prototype.resize.call(this,t),this._clearState();},t.prototype.reset=function(){this._state.start&&this._state.end&&(this._clearState(),this._clearAll());},t.prototype.onSelectionChanged=function(t,r,i){if(e.prototype.onSelectionChanged.call(this,t,r,i),this._didStateChange(t,r,i,this._bufferService.buffer.ydisp))if(this._clearAll(),t&&r){var n=t[1]-this._bufferService.buffer.ydisp,o=r[1]-this._bufferService.buffer.ydisp,s=Math.max(n,0),a=Math.min(o,this._bufferService.rows-1);if(s>=this._bufferService.rows||a<0)this._state.ydisp=this._bufferService.buffer.ydisp;else {if(this._ctx.fillStyle=this._colors.selectionTransparent.css,i){var c=t[0],l=r[0]-c,h=a-s+1;this._fillCells(c,s,l,h);}else {c=n===s?t[0]:0;var u=s===o?r[0]:this._bufferService.cols;this._fillCells(c,s,u-c,1);var f=Math.max(a-s-1,0);if(this._fillCells(0,s+1,this._bufferService.cols,f),s!==a){var _=o===a?r[0]:this._bufferService.cols;this._fillCells(0,a,_,1);}}this._state.start=[t[0],t[1]],this._state.end=[r[0],r[1]],this._state.columnSelectMode=i,this._state.ydisp=this._bufferService.buffer.ydisp;}}else this._clearState();},t.prototype._didStateChange=function(e,t,r,i){return !this._areCoordinatesEqual(e,this._state.start)||!this._areCoordinatesEqual(t,this._state.end)||r!==this._state.columnSelectMode||i!==this._state.ydisp},t.prototype._areCoordinatesEqual=function(e,t){return !(!e||!t)&&e[0]===t[0]&&e[1]===t[1]},o([s(4,c.IBufferService),s(5,c.IOptionsService),s(6,c.IDecorationService)],t)}(a.BaseRenderLayer);t.SelectionRenderLayer=l;},9596:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},a=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.TextRenderLayer=void 0;var c=r(3700),l=r(1546),h=r(3734),u=r(643),f=r(511),_=r(2585),d=r(4725),p=r(4269),v=function(e){function t(t,r,i,n,o,s,a,l,h){var u=e.call(this,t,"text",r,n,i,o,s,a,h)||this;return u._characterJoinerService=l,u._characterWidth=0,u._characterFont="",u._characterOverlapCache={},u._workCell=new f.CellData,u._state=new c.GridCache,u}return n(t,e),t.prototype.resize=function(t){e.prototype.resize.call(this,t);var r=this._getFont(!1,!1);this._characterWidth===t.scaledCharWidth&&this._characterFont===r||(this._characterWidth=t.scaledCharWidth,this._characterFont=r,this._characterOverlapCache={}),this._state.clear(),this._state.resize(this._bufferService.cols,this._bufferService.rows);},t.prototype.reset=function(){this._state.clear(),this._clearAll();},t.prototype._forEachCell=function(e,t,r){for(var i=e;i<=t;i++)for(var n=i+this._bufferService.buffer.ydisp,o=this._bufferService.buffer.lines.get(n),s=this._characterJoinerService.getJoinedCharacters(n),a=0;a<this._bufferService.cols;a++){o.loadCell(a,this._workCell);var c=this._workCell,l=!1,h=a;if(0!==c.getWidth()){if(s.length>0&&a===s[0][0]){l=!0;var f=s.shift();c=new p.JoinedCellData(this._workCell,o.translateToString(!0,f[0],f[1]),f[1]-f[0]),h=f[1]-1;}!l&&this._isOverlapping(c)&&h<o.length-1&&o.getCodePoint(h+1)===u.NULL_CELL_CODE&&(c.content&=-12582913,c.content|=2<<22),r(c,a,i),a=h;}}},t.prototype._drawBackground=function(e,t){var r=this,i=this._ctx,n=this._bufferService.cols,o=0,s=0,c=null;i.save(),this._forEachCell(e,t,(function(e,t,l){var u,f,_=null;e.isInverse()?_=e.isFgDefault()?r._colors.foreground.css:e.isFgRGB()?"rgb("+h.AttributeData.toColorRGB(e.getFgColor()).join(",")+")":r._colors.ansi[e.getFgColor()].css:e.isBgRGB()?_="rgb("+h.AttributeData.toColorRGB(e.getBgColor()).join(",")+")":e.isBgPalette()&&(_=r._colors.ansi[e.getBgColor()].css);var d=!1;try{for(var p=a(r._decorationService.getDecorationsAtCell(t,r._bufferService.buffer.ydisp+l)),v=p.next();!v.done;v=p.next()){var y=v.value;"top"!==y.options.layer&&d||(y.backgroundColorRGB&&(_=y.backgroundColorRGB.css),d="top"===y.options.layer);}}catch(e){u={error:e};}finally{try{v&&!v.done&&(f=p.return)&&f.call(p);}finally{if(u)throw u.error}}null===c&&(o=t,s=l),l!==s?(i.fillStyle=c||"",r._fillCells(o,s,n-o,1),o=t,s=l):c!==_&&(i.fillStyle=c||"",r._fillCells(o,s,t-o,1),o=t,s=l),c=_;})),null!==c&&(i.fillStyle=c,this._fillCells(o,s,n-o,1)),i.restore();},t.prototype._drawForeground=function(e,t){var r=this;this._forEachCell(e,t,(function(e,t,i){if(!e.isInvisible()&&(r._drawChars(e,t,i),e.isUnderline()||e.isStrikethrough())){if(r._ctx.save(),e.isInverse())if(e.isBgDefault())r._ctx.fillStyle=r._colors.background.css;else if(e.isBgRGB())r._ctx.fillStyle="rgb("+h.AttributeData.toColorRGB(e.getBgColor()).join(",")+")";else {var n=e.getBgColor();r._optionsService.rawOptions.drawBoldTextInBrightColors&&e.isBold()&&n<8&&(n+=8),r._ctx.fillStyle=r._colors.ansi[n].css;}else if(e.isFgDefault())r._ctx.fillStyle=r._colors.foreground.css;else if(e.isFgRGB())r._ctx.fillStyle="rgb("+h.AttributeData.toColorRGB(e.getFgColor()).join(",")+")";else {var o=e.getFgColor();r._optionsService.rawOptions.drawBoldTextInBrightColors&&e.isBold()&&o<8&&(o+=8),r._ctx.fillStyle=r._colors.ansi[o].css;}e.isStrikethrough()&&r._fillMiddleLineAtCells(t,i,e.getWidth()),e.isUnderline()&&r._fillBottomLineAtCells(t,i,e.getWidth()),r._ctx.restore();}}));},t.prototype.onGridChanged=function(e,t){0!==this._state.cache.length&&(this._charAtlas&&this._charAtlas.beginFrame(),this._clearCells(0,e,this._bufferService.cols,t-e+1),this._drawBackground(e,t),this._drawForeground(e,t));},t.prototype.onOptionsChanged=function(){this._setTransparency(this._optionsService.rawOptions.allowTransparency);},t.prototype._isOverlapping=function(e){if(1!==e.getWidth())return !1;if(e.getCode()<256)return !1;var t=e.getChars();if(this._characterOverlapCache.hasOwnProperty(t))return this._characterOverlapCache[t];this._ctx.save(),this._ctx.font=this._characterFont;var r=Math.floor(this._ctx.measureText(t).width)>this._characterWidth;return this._ctx.restore(),this._characterOverlapCache[t]=r,r},o([s(5,_.IBufferService),s(6,_.IOptionsService),s(7,d.ICharacterJoinerService),s(8,_.IDecorationService)],t)}(l.BaseRenderLayer);t.TextRenderLayer=v;},9616:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.BaseCharAtlas=void 0;var r=function(){function e(){this._didWarmUp=!1;}return e.prototype.dispose=function(){},e.prototype.warmUp=function(){this._didWarmUp||(this._doWarmUp(),this._didWarmUp=!0);},e.prototype._doWarmUp=function(){},e.prototype.clear=function(){},e.prototype.beginFrame=function(){},e}();t.BaseCharAtlas=r;},1420:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.removeTerminalFromCache=t.acquireCharAtlas=void 0;var i=r(2040),n=r(1906),o=[];t.acquireCharAtlas=function(e,t,r,s,a){for(var c=(0, i.generateConfig)(s,a,e,r),l=0;l<o.length;l++){var h=(u=o[l]).ownedBy.indexOf(t);if(h>=0){if((0, i.configEquals)(u.config,c))return u.atlas;1===u.ownedBy.length?(u.atlas.dispose(),o.splice(l,1)):u.ownedBy.splice(h,1);break}}for(l=0;l<o.length;l++){var u=o[l];if((0, i.configEquals)(u.config,c))return u.ownedBy.push(t),u.atlas}var f={atlas:new n.DynamicCharAtlas(document,c),config:c,ownedBy:[t]};return o.push(f),f.atlas},t.removeTerminalFromCache=function(e){for(var t=0;t<o.length;t++){var r=o[t].ownedBy.indexOf(e);if(-1!==r){1===o[t].ownedBy.length?(o[t].atlas.dispose(),o.splice(t,1)):o[t].ownedBy.splice(r,1);break}}};},2040:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.is256Color=t.configEquals=t.generateConfig=void 0;var i=r(643);t.generateConfig=function(e,t,r,i){var n={foreground:i.foreground,background:i.background,cursor:void 0,cursorAccent:void 0,selection:void 0,ansi:i.ansi.slice()};return {devicePixelRatio:window.devicePixelRatio,scaledCharWidth:e,scaledCharHeight:t,fontFamily:r.fontFamily,fontSize:r.fontSize,fontWeight:r.fontWeight,fontWeightBold:r.fontWeightBold,allowTransparency:r.allowTransparency,colors:n}},t.configEquals=function(e,t){for(var r=0;r<e.colors.ansi.length;r++)if(e.colors.ansi[r].rgba!==t.colors.ansi[r].rgba)return !1;return e.devicePixelRatio===t.devicePixelRatio&&e.fontFamily===t.fontFamily&&e.fontSize===t.fontSize&&e.fontWeight===t.fontWeight&&e.fontWeightBold===t.fontWeightBold&&e.allowTransparency===t.allowTransparency&&e.scaledCharWidth===t.scaledCharWidth&&e.scaledCharHeight===t.scaledCharHeight&&e.colors.foreground===t.colors.foreground&&e.colors.background===t.colors.background},t.is256Color=function(e){return e<i.DEFAULT_COLOR};},8803:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.CHAR_ATLAS_CELL_SPACING=t.TEXT_BASELINE=t.DIM_OPACITY=t.INVERTED_DEFAULT_COLOR=void 0;var i=r(6114);t.INVERTED_DEFAULT_COLOR=257,t.DIM_OPACITY=.5,t.TEXT_BASELINE=i.isFirefox||i.isLegacyEdge?"bottom":"ideographic",t.CHAR_ATLAS_CELL_SPACING=1;},1906:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.NoneCharAtlas=t.DynamicCharAtlas=t.getGlyphCacheKey=void 0;var o=r(8803),s=r(9616),a=r(5680),c=r(7001),l=r(6114),h=r(1752),u=r(8055),f=1024,_=1024,d={css:"rgba(0, 0, 0, 0)",rgba:0};function p(e){return e.code<<21|e.bg<<12|e.fg<<3|(e.bold?0:4)+(e.dim?0:2)+(e.italic?0:1)}t.getGlyphCacheKey=p;var v=function(e){function t(t,r){var i=e.call(this)||this;i._config=r,i._drawToCacheCount=0,i._glyphsWaitingOnBitmap=[],i._bitmapCommitTimeout=null,i._bitmap=null,i._cacheCanvas=t.createElement("canvas"),i._cacheCanvas.width=f,i._cacheCanvas.height=_,i._cacheCtx=(0, h.throwIfFalsy)(i._cacheCanvas.getContext("2d",{alpha:!0}));var n=t.createElement("canvas");n.width=i._config.scaledCharWidth,n.height=i._config.scaledCharHeight,i._tmpCtx=(0, h.throwIfFalsy)(n.getContext("2d",{alpha:i._config.allowTransparency})),i._width=Math.floor(f/i._config.scaledCharWidth),i._height=Math.floor(_/i._config.scaledCharHeight);var o=i._width*i._height;return i._cacheMap=new c.LRUMap(o),i._cacheMap.prealloc(o),i}return n(t,e),t.prototype.dispose=function(){null!==this._bitmapCommitTimeout&&(window.clearTimeout(this._bitmapCommitTimeout),this._bitmapCommitTimeout=null);},t.prototype.beginFrame=function(){this._drawToCacheCount=0;},t.prototype.clear=function(){if(this._cacheMap.size>0){var e=this._width*this._height;this._cacheMap=new c.LRUMap(e),this._cacheMap.prealloc(e);}this._cacheCtx.clearRect(0,0,f,_),this._tmpCtx.clearRect(0,0,this._config.scaledCharWidth,this._config.scaledCharHeight);},t.prototype.draw=function(e,t,r,i){if(32===t.code)return !0;if(!this._canCache(t))return !1;var n=p(t),o=this._cacheMap.get(n);if(null!=o)return this._drawFromCache(e,o,r,i),!0;if(this._drawToCacheCount<100){var s;s=this._cacheMap.size<this._cacheMap.capacity?this._cacheMap.size:this._cacheMap.peek().index;var a=this._drawToCache(t,s);return this._cacheMap.set(n,a),this._drawFromCache(e,a,r,i),!0}return !1},t.prototype._canCache=function(e){return e.code<256},t.prototype._toCoordinateX=function(e){return e%this._width*this._config.scaledCharWidth},t.prototype._toCoordinateY=function(e){return Math.floor(e/this._width)*this._config.scaledCharHeight},t.prototype._drawFromCache=function(e,t,r,i){if(!t.isEmpty){var n=this._toCoordinateX(t.index),o=this._toCoordinateY(t.index);e.drawImage(t.inBitmap?this._bitmap:this._cacheCanvas,n,o,this._config.scaledCharWidth,this._config.scaledCharHeight,r,i,this._config.scaledCharWidth,this._config.scaledCharHeight);}},t.prototype._getColorFromAnsiIndex=function(e){return e<this._config.colors.ansi.length?this._config.colors.ansi[e]:a.DEFAULT_ANSI_COLORS[e]},t.prototype._getBackgroundColor=function(e){return this._config.allowTransparency?d:e.bg===o.INVERTED_DEFAULT_COLOR?this._config.colors.foreground:e.bg<256?this._getColorFromAnsiIndex(e.bg):this._config.colors.background},t.prototype._getForegroundColor=function(e){return e.fg===o.INVERTED_DEFAULT_COLOR?u.color.opaque(this._config.colors.background):e.fg<256?this._getColorFromAnsiIndex(e.fg):this._config.colors.foreground},t.prototype._drawToCache=function(e,t){this._drawToCacheCount++,this._tmpCtx.save();var r=this._getBackgroundColor(e);this._tmpCtx.globalCompositeOperation="copy",this._tmpCtx.fillStyle=r.css,this._tmpCtx.fillRect(0,0,this._config.scaledCharWidth,this._config.scaledCharHeight),this._tmpCtx.globalCompositeOperation="source-over";var i=e.bold?this._config.fontWeightBold:this._config.fontWeight,n=e.italic?"italic":"";this._tmpCtx.font=n+" "+i+" "+this._config.fontSize*this._config.devicePixelRatio+"px "+this._config.fontFamily,this._tmpCtx.textBaseline=o.TEXT_BASELINE,this._tmpCtx.fillStyle=this._getForegroundColor(e).css,e.dim&&(this._tmpCtx.globalAlpha=o.DIM_OPACITY),this._tmpCtx.fillText(e.chars,0,this._config.scaledCharHeight);var s=this._tmpCtx.getImageData(0,0,this._config.scaledCharWidth,this._config.scaledCharHeight),a=!1;if(this._config.allowTransparency||(a=g(s,r)),a&&"_"===e.chars&&!this._config.allowTransparency)for(var c=1;c<=5&&(this._tmpCtx.fillText(e.chars,0,this._config.scaledCharHeight-c),a=g(s=this._tmpCtx.getImageData(0,0,this._config.scaledCharWidth,this._config.scaledCharHeight),r));c++);this._tmpCtx.restore();var l=this._toCoordinateX(t),h=this._toCoordinateY(t);this._cacheCtx.putImageData(s,l,h);var u={index:t,isEmpty:a,inBitmap:!1};return this._addGlyphToBitmap(u),u},t.prototype._addGlyphToBitmap=function(e){var t=this;!("createImageBitmap"in window)||l.isFirefox||l.isSafari||(this._glyphsWaitingOnBitmap.push(e),null===this._bitmapCommitTimeout&&(this._bitmapCommitTimeout=window.setTimeout((function(){return t._generateBitmap()}),100)));},t.prototype._generateBitmap=function(){var e=this,t=this._glyphsWaitingOnBitmap;this._glyphsWaitingOnBitmap=[],window.createImageBitmap(this._cacheCanvas).then((function(r){e._bitmap=r;for(var i=0;i<t.length;i++)t[i].inBitmap=!0;})),this._bitmapCommitTimeout=null;},t}(s.BaseCharAtlas);t.DynamicCharAtlas=v;var y=function(e){function t(t,r){return e.call(this)||this}return n(t,e),t.prototype.draw=function(e,t,r,i){return !1},t}(s.BaseCharAtlas);function g(e,t){for(var r=!0,i=t.rgba>>>24,n=t.rgba>>>16&255,o=t.rgba>>>8&255,s=0;s<e.data.length;s+=4)e.data[s]===i&&e.data[s+1]===n&&e.data[s+2]===o?e.data[s+3]=0:r=!1;return r}t.NoneCharAtlas=y;},7001:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.LRUMap=void 0;var r=function(){function e(e){this.capacity=e,this._map={},this._head=null,this._tail=null,this._nodePool=[],this.size=0;}return e.prototype._unlinkNode=function(e){var t=e.prev,r=e.next;e===this._head&&(this._head=r),e===this._tail&&(this._tail=t),null!==t&&(t.next=r),null!==r&&(r.prev=t);},e.prototype._appendNode=function(e){var t=this._tail;null!==t&&(t.next=e),e.prev=t,e.next=null,this._tail=e,null===this._head&&(this._head=e);},e.prototype.prealloc=function(e){for(var t=this._nodePool,r=0;r<e;r++)t.push({prev:null,next:null,key:null,value:null});},e.prototype.get=function(e){var t=this._map[e];return void 0!==t?(this._unlinkNode(t),this._appendNode(t),t.value):null},e.prototype.peekValue=function(e){var t=this._map[e];return void 0!==t?t.value:null},e.prototype.peek=function(){var e=this._head;return null===e?null:e.value},e.prototype.set=function(e,t){var r=this._map[e];if(void 0!==r)r=this._map[e],this._unlinkNode(r),r.value=t;else if(this.size>=this.capacity)r=this._head,this._unlinkNode(r),delete this._map[r.key],r.key=e,r.value=t,this._map[e]=r;else {var i=this._nodePool;i.length>0?((r=i.pop()).key=e,r.value=t):r={prev:null,next:null,key:e,value:t},this._map[e]=r,this.size++;}this._appendNode(r);},e}();t.LRUMap=r;},1296:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},a=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.DomRenderer=void 0;var c=r(3787),l=r(8803),h=r(844),u=r(4725),f=r(2585),_=r(8460),d=r(8055),p=r(9631),v="xterm-dom-renderer-owner-",y="xterm-fg-",g="xterm-bg-",m="xterm-focus",b=1,S=function(e){function t(t,r,i,n,o,s,a,l,h,u){var f=e.call(this)||this;return f._colors=t,f._element=r,f._screenElement=i,f._viewportElement=n,f._linkifier=o,f._linkifier2=s,f._charSizeService=l,f._optionsService=h,f._bufferService=u,f._terminalClass=b++,f._rowElements=[],f._rowContainer=document.createElement("div"),f._rowContainer.classList.add("xterm-rows"),f._rowContainer.style.lineHeight="normal",f._rowContainer.setAttribute("aria-hidden","true"),f._refreshRowElements(f._bufferService.cols,f._bufferService.rows),f._selectionContainer=document.createElement("div"),f._selectionContainer.classList.add("xterm-selection"),f._selectionContainer.setAttribute("aria-hidden","true"),f.dimensions={scaledCharWidth:0,scaledCharHeight:0,scaledCellWidth:0,scaledCellHeight:0,scaledCharLeft:0,scaledCharTop:0,scaledCanvasWidth:0,scaledCanvasHeight:0,canvasWidth:0,canvasHeight:0,actualCellWidth:0,actualCellHeight:0},f._updateDimensions(),f._injectCss(),f._rowFactory=a.createInstance(c.DomRendererRowFactory,document,f._colors),f._element.classList.add(v+f._terminalClass),f._screenElement.appendChild(f._rowContainer),f._screenElement.appendChild(f._selectionContainer),f.register(f._linkifier.onShowLinkUnderline((function(e){return f._onLinkHover(e)}))),f.register(f._linkifier.onHideLinkUnderline((function(e){return f._onLinkLeave(e)}))),f.register(f._linkifier2.onShowLinkUnderline((function(e){return f._onLinkHover(e)}))),f.register(f._linkifier2.onHideLinkUnderline((function(e){return f._onLinkLeave(e)}))),f}return n(t,e),Object.defineProperty(t.prototype,"onRequestRedraw",{get:function(){return (new _.EventEmitter).event},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){this._element.classList.remove(v+this._terminalClass),(0, p.removeElementFromParent)(this._rowContainer,this._selectionContainer,this._themeStyleElement,this._dimensionsStyleElement),e.prototype.dispose.call(this);},t.prototype._updateDimensions=function(){var e,t;this.dimensions.scaledCharWidth=this._charSizeService.width*window.devicePixelRatio,this.dimensions.scaledCharHeight=Math.ceil(this._charSizeService.height*window.devicePixelRatio),this.dimensions.scaledCellWidth=this.dimensions.scaledCharWidth+Math.round(this._optionsService.rawOptions.letterSpacing),this.dimensions.scaledCellHeight=Math.floor(this.dimensions.scaledCharHeight*this._optionsService.rawOptions.lineHeight),this.dimensions.scaledCharLeft=0,this.dimensions.scaledCharTop=0,this.dimensions.scaledCanvasWidth=this.dimensions.scaledCellWidth*this._bufferService.cols,this.dimensions.scaledCanvasHeight=this.dimensions.scaledCellHeight*this._bufferService.rows,this.dimensions.canvasWidth=Math.round(this.dimensions.scaledCanvasWidth/window.devicePixelRatio),this.dimensions.canvasHeight=Math.round(this.dimensions.scaledCanvasHeight/window.devicePixelRatio),this.dimensions.actualCellWidth=this.dimensions.canvasWidth/this._bufferService.cols,this.dimensions.actualCellHeight=this.dimensions.canvasHeight/this._bufferService.rows;try{for(var r=a(this._rowElements),i=r.next();!i.done;i=r.next()){var n=i.value;n.style.width=this.dimensions.canvasWidth+"px",n.style.height=this.dimensions.actualCellHeight+"px",n.style.lineHeight=this.dimensions.actualCellHeight+"px",n.style.overflow="hidden";}}catch(t){e={error:t};}finally{try{i&&!i.done&&(t=r.return)&&t.call(r);}finally{if(e)throw e.error}}this._dimensionsStyleElement||(this._dimensionsStyleElement=document.createElement("style"),this._screenElement.appendChild(this._dimensionsStyleElement));var o=this._terminalSelector+" .xterm-rows span { display: inline-block; height: 100%; vertical-align: top; width: "+this.dimensions.actualCellWidth+"px}";this._dimensionsStyleElement.textContent=o,this._selectionContainer.style.height=this._viewportElement.style.height,this._screenElement.style.width=this.dimensions.canvasWidth+"px",this._screenElement.style.height=this.dimensions.canvasHeight+"px";},t.prototype.setColors=function(e){this._colors=e,this._injectCss();},t.prototype._injectCss=function(){var e=this;this._themeStyleElement||(this._themeStyleElement=document.createElement("style"),this._screenElement.appendChild(this._themeStyleElement));var t=this._terminalSelector+" .xterm-rows { color: "+this._colors.foreground.css+"; font-family: "+this._optionsService.rawOptions.fontFamily+"; font-size: "+this._optionsService.rawOptions.fontSize+"px;}";t+=this._terminalSelector+" span:not(."+c.BOLD_CLASS+") { font-weight: "+this._optionsService.rawOptions.fontWeight+";}"+this._terminalSelector+" span."+c.BOLD_CLASS+" { font-weight: "+this._optionsService.rawOptions.fontWeightBold+";}"+this._terminalSelector+" span."+c.ITALIC_CLASS+" { font-style: italic;}",t+="@keyframes blink_box_shadow_"+this._terminalClass+" { 50% {  box-shadow: none; }}",t+="@keyframes blink_block_"+this._terminalClass+" { 0% {  background-color: "+this._colors.cursor.css+";  color: "+this._colors.cursorAccent.css+"; } 50% {  background-color: "+this._colors.cursorAccent.css+";  color: "+this._colors.cursor.css+"; }}",t+=this._terminalSelector+" .xterm-rows:not(.xterm-focus) ."+c.CURSOR_CLASS+"."+c.CURSOR_STYLE_BLOCK_CLASS+" { outline: 1px solid "+this._colors.cursor.css+"; outline-offset: -1px;}"+this._terminalSelector+" .xterm-rows.xterm-focus ."+c.CURSOR_CLASS+"."+c.CURSOR_BLINK_CLASS+":not(."+c.CURSOR_STYLE_BLOCK_CLASS+") { animation: blink_box_shadow_"+this._terminalClass+" 1s step-end infinite;}"+this._terminalSelector+" .xterm-rows.xterm-focus ."+c.CURSOR_CLASS+"."+c.CURSOR_BLINK_CLASS+"."+c.CURSOR_STYLE_BLOCK_CLASS+" { animation: blink_block_"+this._terminalClass+" 1s step-end infinite;}"+this._terminalSelector+" .xterm-rows.xterm-focus ."+c.CURSOR_CLASS+"."+c.CURSOR_STYLE_BLOCK_CLASS+" { background-color: "+this._colors.cursor.css+"; color: "+this._colors.cursorAccent.css+";}"+this._terminalSelector+" .xterm-rows ."+c.CURSOR_CLASS+"."+c.CURSOR_STYLE_BAR_CLASS+" { box-shadow: "+this._optionsService.rawOptions.cursorWidth+"px 0 0 "+this._colors.cursor.css+" inset;}"+this._terminalSelector+" .xterm-rows ."+c.CURSOR_CLASS+"."+c.CURSOR_STYLE_UNDERLINE_CLASS+" { box-shadow: 0 -1px 0 "+this._colors.cursor.css+" inset;}",t+=this._terminalSelector+" .xterm-selection { position: absolute; top: 0; left: 0; z-index: 1; pointer-events: none;}"+this._terminalSelector+" .xterm-selection div { position: absolute; background-color: "+this._colors.selectionOpaque.css+";}",this._colors.ansi.forEach((function(r,i){t+=e._terminalSelector+" ."+y+i+" { color: "+r.css+"; }"+e._terminalSelector+" ."+g+i+" { background-color: "+r.css+"; }";})),t+=this._terminalSelector+" ."+y+l.INVERTED_DEFAULT_COLOR+" { color: "+d.color.opaque(this._colors.background).css+"; }"+this._terminalSelector+" ."+g+l.INVERTED_DEFAULT_COLOR+" { background-color: "+this._colors.foreground.css+"; }",this._themeStyleElement.textContent=t;},t.prototype.onDevicePixelRatioChange=function(){this._updateDimensions();},t.prototype._refreshRowElements=function(e,t){for(var r=this._rowElements.length;r<=t;r++){var i=document.createElement("div");this._rowContainer.appendChild(i),this._rowElements.push(i);}for(;this._rowElements.length>t;)this._rowContainer.removeChild(this._rowElements.pop());},t.prototype.onResize=function(e,t){this._refreshRowElements(e,t),this._updateDimensions();},t.prototype.onCharSizeChanged=function(){this._updateDimensions();},t.prototype.onBlur=function(){this._rowContainer.classList.remove(m);},t.prototype.onFocus=function(){this._rowContainer.classList.add(m);},t.prototype.onSelectionChanged=function(e,t,r){for(;this._selectionContainer.children.length;)this._selectionContainer.removeChild(this._selectionContainer.children[0]);if(this._rowFactory.onSelectionChanged(e,t,r),this.renderRows(0,this._bufferService.rows-1),e&&t){var i=e[1]-this._bufferService.buffer.ydisp,n=t[1]-this._bufferService.buffer.ydisp,o=Math.max(i,0),s=Math.min(n,this._bufferService.rows-1);if(!(o>=this._bufferService.rows||s<0)){var a=document.createDocumentFragment();if(r){var c=e[0]>t[0];a.appendChild(this._createSelectionElement(o,c?t[0]:e[0],c?e[0]:t[0],s-o+1));}else {var l=i===o?e[0]:0,h=o===n?t[0]:this._bufferService.cols;a.appendChild(this._createSelectionElement(o,l,h));var u=s-o-1;if(a.appendChild(this._createSelectionElement(o+1,0,this._bufferService.cols,u)),o!==s){var f=n===s?t[0]:this._bufferService.cols;a.appendChild(this._createSelectionElement(s,0,f));}}this._selectionContainer.appendChild(a);}}},t.prototype._createSelectionElement=function(e,t,r,i){void 0===i&&(i=1);var n=document.createElement("div");return n.style.height=i*this.dimensions.actualCellHeight+"px",n.style.top=e*this.dimensions.actualCellHeight+"px",n.style.left=t*this.dimensions.actualCellWidth+"px",n.style.width=this.dimensions.actualCellWidth*(r-t)+"px",n},t.prototype.onCursorMove=function(){},t.prototype.onOptionsChanged=function(){this._updateDimensions(),this._injectCss();},t.prototype.clear=function(){var e,t;try{for(var r=a(this._rowElements),i=r.next();!i.done;i=r.next())i.value.innerText="";}catch(t){e={error:t};}finally{try{i&&!i.done&&(t=r.return)&&t.call(r);}finally{if(e)throw e.error}}},t.prototype.renderRows=function(e,t){for(var r=this._bufferService.buffer.ybase+this._bufferService.buffer.y,i=Math.min(this._bufferService.buffer.x,this._bufferService.cols-1),n=this._optionsService.rawOptions.cursorBlink,o=e;o<=t;o++){var s=this._rowElements[o];s.innerText="";var a=o+this._bufferService.buffer.ydisp,c=this._bufferService.buffer.lines.get(a),l=this._optionsService.rawOptions.cursorStyle;s.appendChild(this._rowFactory.createRow(c,a,a===r,l,i,n,this.dimensions.actualCellWidth,this._bufferService.cols));}},Object.defineProperty(t.prototype,"_terminalSelector",{get:function(){return "."+v+this._terminalClass},enumerable:!1,configurable:!0}),t.prototype._onLinkHover=function(e){this._setCellUnderline(e.x1,e.x2,e.y1,e.y2,e.cols,!0);},t.prototype._onLinkLeave=function(e){this._setCellUnderline(e.x1,e.x2,e.y1,e.y2,e.cols,!1);},t.prototype._setCellUnderline=function(e,t,r,i,n,o){for(;e!==t||r!==i;){var s=this._rowElements[r];if(!s)return;var a=s.children[e];a&&(a.style.textDecoration=o?"underline":"none"),++e>=n&&(e=0,r++);}},o([s(6,f.IInstantiationService),s(7,u.ICharSizeService),s(8,f.IOptionsService),s(9,f.IBufferService)],t)}(h.Disposable);t.DomRenderer=S;},3787:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},o=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.DomRendererRowFactory=t.CURSOR_STYLE_UNDERLINE_CLASS=t.CURSOR_STYLE_BAR_CLASS=t.CURSOR_STYLE_BLOCK_CLASS=t.CURSOR_BLINK_CLASS=t.CURSOR_CLASS=t.STRIKETHROUGH_CLASS=t.UNDERLINE_CLASS=t.ITALIC_CLASS=t.DIM_CLASS=t.BOLD_CLASS=void 0;var s=r(8803),a=r(643),c=r(511),l=r(2585),h=r(8055),u=r(4725),f=r(4269),_=r(1752);t.BOLD_CLASS="xterm-bold",t.DIM_CLASS="xterm-dim",t.ITALIC_CLASS="xterm-italic",t.UNDERLINE_CLASS="xterm-underline",t.STRIKETHROUGH_CLASS="xterm-strikethrough",t.CURSOR_CLASS="xterm-cursor",t.CURSOR_BLINK_CLASS="xterm-cursor-blink",t.CURSOR_STYLE_BLOCK_CLASS="xterm-cursor-block",t.CURSOR_STYLE_BAR_CLASS="xterm-cursor-bar",t.CURSOR_STYLE_UNDERLINE_CLASS="xterm-cursor-underline";var d=function(){function e(e,t,r,i,n,o){this._document=e,this._colors=t,this._characterJoinerService=r,this._optionsService=i,this._coreService=n,this._decorationService=o,this._workCell=new c.CellData,this._columnSelectMode=!1;}return e.prototype.setColors=function(e){this._colors=e;},e.prototype.onSelectionChanged=function(e,t,r){this._selectionStart=e,this._selectionEnd=t,this._columnSelectMode=r;},e.prototype.createRow=function(e,r,i,n,c,l,u,_){for(var d,v,y=this._document.createDocumentFragment(),g=this._characterJoinerService.getJoinedCharacters(r),m=0,b=Math.min(e.length,_)-1;b>=0;b--)if(e.loadCell(b,this._workCell).getCode()!==a.NULL_CELL_CODE||i&&b===c){m=b+1;break}for(b=0;b<m;b++){e.loadCell(b,this._workCell);var S=this._workCell.getWidth();if(0!==S){var C=!1,w=b,L=this._workCell;if(g.length>0&&b===g[0][0]){C=!0;var E=g.shift();L=new f.JoinedCellData(this._workCell,e.translateToString(!0,E[0],E[1]),E[1]-E[0]),w=E[1]-1,S=L.getWidth();}var x=this._document.createElement("span");if(S>1&&(x.style.width=u*S+"px"),C&&(x.style.display="inline",c>=b&&c<=w&&(c=b)),!this._coreService.isCursorHidden&&i&&b===c)switch(x.classList.add(t.CURSOR_CLASS),l&&x.classList.add(t.CURSOR_BLINK_CLASS),n){case"bar":x.classList.add(t.CURSOR_STYLE_BAR_CLASS);break;case"underline":x.classList.add(t.CURSOR_STYLE_UNDERLINE_CLASS);break;default:x.classList.add(t.CURSOR_STYLE_BLOCK_CLASS);}L.isBold()&&x.classList.add(t.BOLD_CLASS),L.isItalic()&&x.classList.add(t.ITALIC_CLASS),L.isDim()&&x.classList.add(t.DIM_CLASS),L.isUnderline()&&x.classList.add(t.UNDERLINE_CLASS),L.isInvisible()?x.textContent=a.WHITESPACE_CELL_CHAR:x.textContent=L.getChars()||a.WHITESPACE_CELL_CHAR,L.isStrikethrough()&&x.classList.add(t.STRIKETHROUGH_CLASS);var R=L.getFgColor(),k=L.getFgColorMode(),M=L.getBgColor(),A=L.getBgColorMode(),O=!!L.isInverse();if(O){var D=R;R=M,M=D;var T=k;k=A,A=T;}var B=void 0,P=void 0,I=!1;try{for(var H=(d=void 0,o(this._decorationService.getDecorationsAtCell(b,r))),j=H.next();!j.done;j=H.next()){var F=j.value;"top"!==F.options.layer&&I||(F.backgroundColorRGB&&(A=50331648,M=F.backgroundColorRGB.rgba>>8&16777215,B=F.backgroundColorRGB),F.foregroundColorRGB&&(k=50331648,R=F.foregroundColorRGB.rgba>>8&16777215,P=F.foregroundColorRGB),I="top"===F.options.layer);}}catch(e){d={error:e};}finally{try{j&&!j.done&&(v=H.return)&&v.call(H);}finally{if(d)throw d.error}}var W=this._isCellInSelection(b,r);I||this._colors.selectionForeground&&W&&(k=50331648,R=this._colors.selectionForeground.rgba>>8&16777215,P=this._colors.selectionForeground),W&&(B=this._colors.selectionOpaque,I=!0),I&&x.classList.add("xterm-decoration-top");var U=void 0;switch(A){case 16777216:case 33554432:U=this._colors.ansi[M],x.classList.add("xterm-bg-"+M);break;case 50331648:U=h.rgba.toColor(M>>16,M>>8&255,255&M),this._addStyle(x,"background-color:#"+p((M>>>0).toString(16),"0",6));break;default:O?(U=this._colors.foreground,x.classList.add("xterm-bg-"+s.INVERTED_DEFAULT_COLOR)):U=this._colors.background;}switch(k){case 16777216:case 33554432:L.isBold()&&R<8&&this._optionsService.rawOptions.drawBoldTextInBrightColors&&(R+=8),this._applyMinimumContrast(x,U,this._colors.ansi[R],L,B,void 0)||x.classList.add("xterm-fg-"+R);break;case 50331648:var q=h.rgba.toColor(R>>16&255,R>>8&255,255&R);this._applyMinimumContrast(x,U,q,L,B,P)||this._addStyle(x,"color:#"+p(R.toString(16),"0",6));break;default:this._applyMinimumContrast(x,U,this._colors.foreground,L,B,void 0)||O&&x.classList.add("xterm-fg-"+s.INVERTED_DEFAULT_COLOR);}y.appendChild(x),b=w;}}return y},e.prototype._applyMinimumContrast=function(e,t,r,i,n,o){if(1===this._optionsService.rawOptions.minimumContrastRatio||(0, _.excludeFromContrastRatioDemands)(i.getCode()))return !1;var s=void 0;return n||o||(s=this._colors.contrastCache.getColor(t.rgba,r.rgba)),void 0===s&&(s=h.color.ensureContrastRatio(n||t,o||r,this._optionsService.rawOptions.minimumContrastRatio),this._colors.contrastCache.setColor((n||t).rgba,(o||r).rgba,null!=s?s:null)),!!s&&(this._addStyle(e,"color:"+s.css),!0)},e.prototype._addStyle=function(e,t){e.setAttribute("style",""+(e.getAttribute("style")||"")+t+";");},e.prototype._isCellInSelection=function(e,t){var r=this._selectionStart,i=this._selectionEnd;return !(!r||!i)&&(this._columnSelectMode?r[0]<=i[0]?e>=r[0]&&t>=r[1]&&e<i[0]&&t<=i[1]:e<r[0]&&t>=r[1]&&e>=i[0]&&t<=i[1]:t>r[1]&&t<i[1]||r[1]===i[1]&&t===r[1]&&e>=r[0]&&e<i[0]||r[1]<i[1]&&t===i[1]&&e<i[0]||r[1]<i[1]&&t===r[1]&&e>=r[0])},i([n(2,u.ICharacterJoinerService),n(3,l.IOptionsService),n(4,l.ICoreService),n(5,l.IDecorationService)],e)}();function p(e,t,r){for(;e.length<r;)e=t+e;return e}t.DomRendererRowFactory=d;},456:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.SelectionModel=void 0;var r=function(){function e(e){this._bufferService=e,this.isSelectAllActive=!1,this.selectionStartLength=0;}return e.prototype.clearSelection=function(){this.selectionStart=void 0,this.selectionEnd=void 0,this.isSelectAllActive=!1,this.selectionStartLength=0;},Object.defineProperty(e.prototype,"finalSelectionStart",{get:function(){return this.isSelectAllActive?[0,0]:this.selectionEnd&&this.selectionStart&&this.areSelectionValuesReversed()?this.selectionEnd:this.selectionStart},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"finalSelectionEnd",{get:function(){return this.isSelectAllActive?[this._bufferService.cols,this._bufferService.buffer.ybase+this._bufferService.rows-1]:this.selectionStart?!this.selectionEnd||this.areSelectionValuesReversed()?(e=this.selectionStart[0]+this.selectionStartLength)>this._bufferService.cols?e%this._bufferService.cols==0?[this._bufferService.cols,this.selectionStart[1]+Math.floor(e/this._bufferService.cols)-1]:[e%this._bufferService.cols,this.selectionStart[1]+Math.floor(e/this._bufferService.cols)]:[e,this.selectionStart[1]]:this.selectionStartLength&&this.selectionEnd[1]===this.selectionStart[1]?(e=this.selectionStart[0]+this.selectionStartLength)>this._bufferService.cols?[e%this._bufferService.cols,this.selectionStart[1]+Math.floor(e/this._bufferService.cols)]:[Math.max(e,this.selectionEnd[0]),this.selectionEnd[1]]:this.selectionEnd:void 0;var e;},enumerable:!1,configurable:!0}),e.prototype.areSelectionValuesReversed=function(){var e=this.selectionStart,t=this.selectionEnd;return !(!e||!t)&&(e[1]>t[1]||e[1]===t[1]&&e[0]>t[0])},e.prototype.onTrim=function(e){return this.selectionStart&&(this.selectionStart[1]-=e),this.selectionEnd&&(this.selectionEnd[1]-=e),this.selectionEnd&&this.selectionEnd[1]<0?(this.clearSelection(),!0):(this.selectionStart&&this.selectionStart[1]<0&&(this.selectionStart[1]=0),!1)},e}();t.SelectionModel=r;},428:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.CharSizeService=void 0;var o=r(2585),s=r(8460),a=function(){function e(e,t,r){this._optionsService=r,this.width=0,this.height=0,this._onCharSizeChange=new s.EventEmitter,this._measureStrategy=new c(e,t,this._optionsService);}return Object.defineProperty(e.prototype,"hasValidSize",{get:function(){return this.width>0&&this.height>0},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onCharSizeChange",{get:function(){return this._onCharSizeChange.event},enumerable:!1,configurable:!0}),e.prototype.measure=function(){var e=this._measureStrategy.measure();e.width===this.width&&e.height===this.height||(this.width=e.width,this.height=e.height,this._onCharSizeChange.fire());},i([n(2,o.IOptionsService)],e)}();t.CharSizeService=a;var c=function(){function e(e,t,r){this._document=e,this._parentElement=t,this._optionsService=r,this._result={width:0,height:0},this._measureElement=this._document.createElement("span"),this._measureElement.classList.add("xterm-char-measure-element"),this._measureElement.textContent="W",this._measureElement.setAttribute("aria-hidden","true"),this._parentElement.appendChild(this._measureElement);}return e.prototype.measure=function(){this._measureElement.style.fontFamily=this._optionsService.rawOptions.fontFamily,this._measureElement.style.fontSize=this._optionsService.rawOptions.fontSize+"px";var e=this._measureElement.getBoundingClientRect();return 0!==e.width&&0!==e.height&&(this._result.width=e.width,this._result.height=Math.ceil(e.height)),this._result},e}();},4269:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.CharacterJoinerService=t.JoinedCellData=void 0;var a=r(3734),c=r(643),l=r(511),h=r(2585),u=function(e){function t(t,r,i){var n=e.call(this)||this;return n.content=0,n.combinedData="",n.fg=t.fg,n.bg=t.bg,n.combinedData=r,n._width=i,n}return n(t,e),t.prototype.isCombined=function(){return 2097152},t.prototype.getWidth=function(){return this._width},t.prototype.getChars=function(){return this.combinedData},t.prototype.getCode=function(){return 2097151},t.prototype.setFromCharData=function(e){throw new Error("not implemented")},t.prototype.getAsCharData=function(){return [this.fg,this.getChars(),this.getWidth(),this.getCode()]},t}(a.AttributeData);t.JoinedCellData=u;var f=function(){function e(e){this._bufferService=e,this._characterJoiners=[],this._nextCharacterJoinerId=0,this._workCell=new l.CellData;}return e.prototype.register=function(e){var t={id:this._nextCharacterJoinerId++,handler:e};return this._characterJoiners.push(t),t.id},e.prototype.deregister=function(e){for(var t=0;t<this._characterJoiners.length;t++)if(this._characterJoiners[t].id===e)return this._characterJoiners.splice(t,1),!0;return !1},e.prototype.getJoinedCharacters=function(e){if(0===this._characterJoiners.length)return [];var t=this._bufferService.buffer.lines.get(e);if(!t||0===t.length)return [];for(var r=[],i=t.translateToString(!0),n=0,o=0,s=0,a=t.getFg(0),l=t.getBg(0),h=0;h<t.getTrimmedLength();h++)if(t.loadCell(h,this._workCell),0!==this._workCell.getWidth()){if(this._workCell.fg!==a||this._workCell.bg!==l){if(h-n>1)for(var u=this._getJoinedRanges(i,s,o,t,n),f=0;f<u.length;f++)r.push(u[f]);n=h,s=o,a=this._workCell.fg,l=this._workCell.bg;}o+=this._workCell.getChars().length||c.WHITESPACE_CELL_CHAR.length;}if(this._bufferService.cols-n>1)for(u=this._getJoinedRanges(i,s,o,t,n),f=0;f<u.length;f++)r.push(u[f]);return r},e.prototype._getJoinedRanges=function(t,r,i,n,o){var s=t.substring(r,i),a=[];try{a=this._characterJoiners[0].handler(s);}catch(e){console.error(e);}for(var c=1;c<this._characterJoiners.length;c++)try{for(var l=this._characterJoiners[c].handler(s),h=0;h<l.length;h++)e._mergeRanges(a,l[h]);}catch(e){console.error(e);}return this._stringRangesToCellRanges(a,n,o),a},e.prototype._stringRangesToCellRanges=function(e,t,r){var i=0,n=!1,o=0,s=e[i];if(s){for(var a=r;a<this._bufferService.cols;a++){var l=t.getWidth(a),h=t.getString(a).length||c.WHITESPACE_CELL_CHAR.length;if(0!==l){if(!n&&s[0]<=o&&(s[0]=a,n=!0),s[1]<=o){if(s[1]=a,!(s=e[++i]))break;s[0]<=o?(s[0]=a,n=!0):n=!1;}o+=h;}}s&&(s[1]=this._bufferService.cols);}},e._mergeRanges=function(e,t){for(var r=!1,i=0;i<e.length;i++){var n=e[i];if(r){if(t[1]<=n[0])return e[i-1][1]=t[1],e;if(t[1]<=n[1])return e[i-1][1]=Math.max(t[1],n[1]),e.splice(i,1),e;e.splice(i,1),i--;}else {if(t[1]<=n[0])return e.splice(i,0,t),e;if(t[1]<=n[1])return n[0]=Math.min(t[0],n[0]),e;t[0]<n[1]&&(n[0]=Math.min(t[0],n[0]),r=!0);}}return r?e[e.length-1][1]=t[1]:e.push(t),e},e=o([s(0,h.IBufferService)],e)}();t.CharacterJoinerService=f;},5114:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.CoreBrowserService=void 0;var r=function(){function e(e){this._textarea=e;}return Object.defineProperty(e.prototype,"isFocused",{get:function(){return (this._textarea.getRootNode?this._textarea.getRootNode():document).activeElement===this._textarea&&document.hasFocus()},enumerable:!1,configurable:!0}),e}();t.CoreBrowserService=r;},8934:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.MouseService=void 0;var o=r(4725),s=r(9806),a=function(){function e(e,t){this._renderService=e,this._charSizeService=t;}return e.prototype.getCoords=function(e,t,r,i,n){return (0, s.getCoords)(window,e,t,r,i,this._charSizeService.hasValidSize,this._renderService.dimensions.actualCellWidth,this._renderService.dimensions.actualCellHeight,n)},e.prototype.getRawByteCoords=function(e,t,r,i){var n=this.getCoords(e,t,r,i);return (0, s.getRawByteCoords)(n)},i([n(0,o.IRenderService),n(1,o.ICharSizeService)],e)}();t.MouseService=a;},3230:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.RenderService=void 0;var a=r(6193),c=r(8460),l=r(844),h=r(5596),u=r(3656),f=r(2585),_=r(4725),d=function(e){function t(t,r,i,n,o,s,l){var f=e.call(this)||this;if(f._renderer=t,f._rowCount=r,f._charSizeService=o,f._isPaused=!1,f._needsFullRefresh=!1,f._isNextRenderRedrawOnly=!0,f._needsSelectionRefresh=!1,f._canvasWidth=0,f._canvasHeight=0,f._selectionState={start:void 0,end:void 0,columnSelectMode:!1},f._onDimensionsChange=new c.EventEmitter,f._onRenderedViewportChange=new c.EventEmitter,f._onRender=new c.EventEmitter,f._onRefreshRequest=new c.EventEmitter,f.register({dispose:function(){return f._renderer.dispose()}}),f._renderDebouncer=new a.RenderDebouncer((function(e,t){return f._renderRows(e,t)})),f.register(f._renderDebouncer),f._screenDprMonitor=new h.ScreenDprMonitor,f._screenDprMonitor.setListener((function(){return f.onDevicePixelRatioChange()})),f.register(f._screenDprMonitor),f.register(l.onResize((function(){return f._fullRefresh()}))),f.register(l.buffers.onBufferActivate((function(){var e;return null===(e=f._renderer)||void 0===e?void 0:e.clear()}))),f.register(n.onOptionChange((function(){return f._handleOptionsChanged()}))),f.register(f._charSizeService.onCharSizeChange((function(){return f.onCharSizeChanged()}))),f.register(s.onDecorationRegistered((function(){return f._fullRefresh()}))),f.register(s.onDecorationRemoved((function(){return f._fullRefresh()}))),f._renderer.onRequestRedraw((function(e){return f.refreshRows(e.start,e.end,!0)})),f.register((0, u.addDisposableDomListener)(window,"resize",(function(){return f.onDevicePixelRatioChange()}))),"IntersectionObserver"in window){var _=new IntersectionObserver((function(e){return f._onIntersectionChange(e[e.length-1])}),{threshold:0});_.observe(i),f.register({dispose:function(){return _.disconnect()}});}return f}return n(t,e),Object.defineProperty(t.prototype,"onDimensionsChange",{get:function(){return this._onDimensionsChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRenderedViewportChange",{get:function(){return this._onRenderedViewportChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRender",{get:function(){return this._onRender.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRefreshRequest",{get:function(){return this._onRefreshRequest.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"dimensions",{get:function(){return this._renderer.dimensions},enumerable:!1,configurable:!0}),t.prototype._onIntersectionChange=function(e){this._isPaused=void 0===e.isIntersecting?0===e.intersectionRatio:!e.isIntersecting,this._isPaused||this._charSizeService.hasValidSize||this._charSizeService.measure(),!this._isPaused&&this._needsFullRefresh&&(this.refreshRows(0,this._rowCount-1),this._needsFullRefresh=!1);},t.prototype.refreshRows=function(e,t,r){void 0===r&&(r=!1),this._isPaused?this._needsFullRefresh=!0:(r||(this._isNextRenderRedrawOnly=!1),this._renderDebouncer.refresh(e,t,this._rowCount));},t.prototype._renderRows=function(e,t){this._renderer.renderRows(e,t),this._needsSelectionRefresh&&(this._renderer.onSelectionChanged(this._selectionState.start,this._selectionState.end,this._selectionState.columnSelectMode),this._needsSelectionRefresh=!1),this._isNextRenderRedrawOnly||this._onRenderedViewportChange.fire({start:e,end:t}),this._onRender.fire({start:e,end:t}),this._isNextRenderRedrawOnly=!0;},t.prototype.resize=function(e,t){this._rowCount=t,this._fireOnCanvasResize();},t.prototype._handleOptionsChanged=function(){this._renderer.onOptionsChanged(),this.refreshRows(0,this._rowCount-1),this._fireOnCanvasResize();},t.prototype._fireOnCanvasResize=function(){this._renderer.dimensions.canvasWidth===this._canvasWidth&&this._renderer.dimensions.canvasHeight===this._canvasHeight||this._onDimensionsChange.fire(this._renderer.dimensions);},t.prototype.dispose=function(){e.prototype.dispose.call(this);},t.prototype.setRenderer=function(e){var t=this;this._renderer.dispose(),this._renderer=e,this._renderer.onRequestRedraw((function(e){return t.refreshRows(e.start,e.end,!0)})),this._needsSelectionRefresh=!0,this._fullRefresh();},t.prototype.addRefreshCallback=function(e){return this._renderDebouncer.addRefreshCallback(e)},t.prototype._fullRefresh=function(){this._isPaused?this._needsFullRefresh=!0:this.refreshRows(0,this._rowCount-1);},t.prototype.clearTextureAtlas=function(){var e,t;null===(t=null===(e=this._renderer)||void 0===e?void 0:e.clearTextureAtlas)||void 0===t||t.call(e),this._fullRefresh();},t.prototype.setColors=function(e){this._renderer.setColors(e),this._fullRefresh();},t.prototype.onDevicePixelRatioChange=function(){this._charSizeService.measure(),this._renderer.onDevicePixelRatioChange(),this.refreshRows(0,this._rowCount-1);},t.prototype.onResize=function(e,t){this._renderer.onResize(e,t),this._fullRefresh();},t.prototype.onCharSizeChanged=function(){this._renderer.onCharSizeChanged();},t.prototype.onBlur=function(){this._renderer.onBlur();},t.prototype.onFocus=function(){this._renderer.onFocus();},t.prototype.onSelectionChanged=function(e,t,r){this._selectionState.start=e,this._selectionState.end=t,this._selectionState.columnSelectMode=r,this._renderer.onSelectionChanged(e,t,r);},t.prototype.onCursorMove=function(){this._renderer.onCursorMove();},t.prototype.clear=function(){this._renderer.clear();},o([s(3,f.IOptionsService),s(4,_.ICharSizeService),s(5,f.IDecorationService),s(6,f.IBufferService)],t)}(l.Disposable);t.RenderService=d;},9312:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.SelectionService=void 0;var a=r(6114),c=r(456),l=r(511),h=r(8460),u=r(4725),f=r(2585),_=r(9806),d=r(9504),p=r(844),v=r(4841),y=String.fromCharCode(160),g=new RegExp(y,"g"),m=function(e){function t(t,r,i,n,o,s,a,u){var f=e.call(this)||this;return f._element=t,f._screenElement=r,f._linkifier=i,f._bufferService=n,f._coreService=o,f._mouseService=s,f._optionsService=a,f._renderService=u,f._dragScrollAmount=0,f._enabled=!0,f._workCell=new l.CellData,f._mouseDownTimeStamp=0,f._oldHasSelection=!1,f._oldSelectionStart=void 0,f._oldSelectionEnd=void 0,f._onLinuxMouseSelection=f.register(new h.EventEmitter),f._onRedrawRequest=f.register(new h.EventEmitter),f._onSelectionChange=f.register(new h.EventEmitter),f._onRequestScrollLines=f.register(new h.EventEmitter),f._mouseMoveListener=function(e){return f._onMouseMove(e)},f._mouseUpListener=function(e){return f._onMouseUp(e)},f._coreService.onUserInput((function(){f.hasSelection&&f.clearSelection();})),f._trimListener=f._bufferService.buffer.lines.onTrim((function(e){return f._onTrim(e)})),f.register(f._bufferService.buffers.onBufferActivate((function(e){return f._onBufferActivate(e)}))),f.enable(),f._model=new c.SelectionModel(f._bufferService),f._activeSelectionMode=0,f}return n(t,e),Object.defineProperty(t.prototype,"onLinuxMouseSelection",{get:function(){return this._onLinuxMouseSelection.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestRedraw",{get:function(){return this._onRedrawRequest.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onSelectionChange",{get:function(){return this._onSelectionChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestScrollLines",{get:function(){return this._onRequestScrollLines.event},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){this._removeMouseDownListeners();},t.prototype.reset=function(){this.clearSelection();},t.prototype.disable=function(){this.clearSelection(),this._enabled=!1;},t.prototype.enable=function(){this._enabled=!0;},Object.defineProperty(t.prototype,"selectionStart",{get:function(){return this._model.finalSelectionStart},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"selectionEnd",{get:function(){return this._model.finalSelectionEnd},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"hasSelection",{get:function(){var e=this._model.finalSelectionStart,t=this._model.finalSelectionEnd;return !(!e||!t||e[0]===t[0]&&e[1]===t[1])},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"selectionText",{get:function(){var e=this._model.finalSelectionStart,t=this._model.finalSelectionEnd;if(!e||!t)return "";var r=this._bufferService.buffer,i=[];if(3===this._activeSelectionMode){if(e[0]===t[0])return "";for(var n=e[0]<t[0]?e[0]:t[0],o=e[0]<t[0]?t[0]:e[0],s=e[1];s<=t[1];s++){var c=r.translateBufferLineToString(s,!0,n,o);i.push(c);}}else {var l=e[1]===t[1]?t[0]:void 0;for(i.push(r.translateBufferLineToString(e[1],!0,e[0],l)),s=e[1]+1;s<=t[1]-1;s++){var h=r.lines.get(s);c=r.translateBufferLineToString(s,!0),(null==h?void 0:h.isWrapped)?i[i.length-1]+=c:i.push(c);}e[1]!==t[1]&&(h=r.lines.get(t[1]),c=r.translateBufferLineToString(t[1],!0,0,t[0]),h&&h.isWrapped?i[i.length-1]+=c:i.push(c));}return i.map((function(e){return e.replace(g," ")})).join(a.isWindows?"\r\n":"\n")},enumerable:!1,configurable:!0}),t.prototype.clearSelection=function(){this._model.clearSelection(),this._removeMouseDownListeners(),this.refresh(),this._onSelectionChange.fire();},t.prototype.refresh=function(e){var t=this;this._refreshAnimationFrame||(this._refreshAnimationFrame=window.requestAnimationFrame((function(){return t._refresh()}))),a.isLinux&&e&&this.selectionText.length&&this._onLinuxMouseSelection.fire(this.selectionText);},t.prototype._refresh=function(){this._refreshAnimationFrame=void 0,this._onRedrawRequest.fire({start:this._model.finalSelectionStart,end:this._model.finalSelectionEnd,columnSelectMode:3===this._activeSelectionMode});},t.prototype._isClickInSelection=function(e){var t=this._getMouseBufferCoords(e),r=this._model.finalSelectionStart,i=this._model.finalSelectionEnd;return !!(r&&i&&t)&&this._areCoordsInSelection(t,r,i)},t.prototype.isCellInSelection=function(e,t){var r=this._model.finalSelectionStart,i=this._model.finalSelectionEnd;return !(!r||!i)&&this._areCoordsInSelection([e,t],r,i)},t.prototype._areCoordsInSelection=function(e,t,r){return e[1]>t[1]&&e[1]<r[1]||t[1]===r[1]&&e[1]===t[1]&&e[0]>=t[0]&&e[0]<r[0]||t[1]<r[1]&&e[1]===r[1]&&e[0]<r[0]||t[1]<r[1]&&e[1]===t[1]&&e[0]>=t[0]},t.prototype._selectWordAtCursor=function(e,t){var r,i,n=null===(i=null===(r=this._linkifier.currentLink)||void 0===r?void 0:r.link)||void 0===i?void 0:i.range;if(n)return this._model.selectionStart=[n.start.x-1,n.start.y-1],this._model.selectionStartLength=(0, v.getRangeLength)(n,this._bufferService.cols),this._model.selectionEnd=void 0,!0;var o=this._getMouseBufferCoords(e);return !!o&&(this._selectWordAt(o,t),this._model.selectionEnd=void 0,!0)},t.prototype.selectAll=function(){this._model.isSelectAllActive=!0,this.refresh(),this._onSelectionChange.fire();},t.prototype.selectLines=function(e,t){this._model.clearSelection(),e=Math.max(e,0),t=Math.min(t,this._bufferService.buffer.lines.length-1),this._model.selectionStart=[0,e],this._model.selectionEnd=[this._bufferService.cols,t],this.refresh(),this._onSelectionChange.fire();},t.prototype._onTrim=function(e){this._model.onTrim(e)&&this.refresh();},t.prototype._getMouseBufferCoords=function(e){var t=this._mouseService.getCoords(e,this._screenElement,this._bufferService.cols,this._bufferService.rows,!0);if(t)return t[0]--,t[1]--,t[1]+=this._bufferService.buffer.ydisp,t},t.prototype._getMouseEventScrollAmount=function(e){var t=(0, _.getCoordsRelativeToElement)(window,e,this._screenElement)[1],r=this._renderService.dimensions.canvasHeight;return t>=0&&t<=r?0:(t>r&&(t-=r),t=Math.min(Math.max(t,-50),50),(t/=50)/Math.abs(t)+Math.round(14*t))},t.prototype.shouldForceSelection=function(e){return a.isMac?e.altKey&&this._optionsService.rawOptions.macOptionClickForcesSelection:e.shiftKey},t.prototype.onMouseDown=function(e){if(this._mouseDownTimeStamp=e.timeStamp,(2!==e.button||!this.hasSelection)&&0===e.button){if(!this._enabled){if(!this.shouldForceSelection(e))return;e.stopPropagation();}e.preventDefault(),this._dragScrollAmount=0,this._enabled&&e.shiftKey?this._onIncrementalClick(e):1===e.detail?this._onSingleClick(e):2===e.detail?this._onDoubleClick(e):3===e.detail&&this._onTripleClick(e),this._addMouseDownListeners(),this.refresh(!0);}},t.prototype._addMouseDownListeners=function(){var e=this;this._screenElement.ownerDocument&&(this._screenElement.ownerDocument.addEventListener("mousemove",this._mouseMoveListener),this._screenElement.ownerDocument.addEventListener("mouseup",this._mouseUpListener)),this._dragScrollIntervalTimer=window.setInterval((function(){return e._dragScroll()}),50);},t.prototype._removeMouseDownListeners=function(){this._screenElement.ownerDocument&&(this._screenElement.ownerDocument.removeEventListener("mousemove",this._mouseMoveListener),this._screenElement.ownerDocument.removeEventListener("mouseup",this._mouseUpListener)),clearInterval(this._dragScrollIntervalTimer),this._dragScrollIntervalTimer=void 0;},t.prototype._onIncrementalClick=function(e){this._model.selectionStart&&(this._model.selectionEnd=this._getMouseBufferCoords(e));},t.prototype._onSingleClick=function(e){if(this._model.selectionStartLength=0,this._model.isSelectAllActive=!1,this._activeSelectionMode=this.shouldColumnSelect(e)?3:0,this._model.selectionStart=this._getMouseBufferCoords(e),this._model.selectionStart){this._model.selectionEnd=void 0;var t=this._bufferService.buffer.lines.get(this._model.selectionStart[1]);t&&t.length!==this._model.selectionStart[0]&&0===t.hasWidth(this._model.selectionStart[0])&&this._model.selectionStart[0]++;}},t.prototype._onDoubleClick=function(e){this._selectWordAtCursor(e,!0)&&(this._activeSelectionMode=1);},t.prototype._onTripleClick=function(e){var t=this._getMouseBufferCoords(e);t&&(this._activeSelectionMode=2,this._selectLineAt(t[1]));},t.prototype.shouldColumnSelect=function(e){return e.altKey&&!(a.isMac&&this._optionsService.rawOptions.macOptionClickForcesSelection)},t.prototype._onMouseMove=function(e){if(e.stopImmediatePropagation(),this._model.selectionStart){var t=this._model.selectionEnd?[this._model.selectionEnd[0],this._model.selectionEnd[1]]:null;if(this._model.selectionEnd=this._getMouseBufferCoords(e),this._model.selectionEnd){2===this._activeSelectionMode?this._model.selectionEnd[1]<this._model.selectionStart[1]?this._model.selectionEnd[0]=0:this._model.selectionEnd[0]=this._bufferService.cols:1===this._activeSelectionMode&&this._selectToWordAt(this._model.selectionEnd),this._dragScrollAmount=this._getMouseEventScrollAmount(e),3!==this._activeSelectionMode&&(this._dragScrollAmount>0?this._model.selectionEnd[0]=this._bufferService.cols:this._dragScrollAmount<0&&(this._model.selectionEnd[0]=0));var r=this._bufferService.buffer;if(this._model.selectionEnd[1]<r.lines.length){var i=r.lines.get(this._model.selectionEnd[1]);i&&0===i.hasWidth(this._model.selectionEnd[0])&&this._model.selectionEnd[0]++;}t&&t[0]===this._model.selectionEnd[0]&&t[1]===this._model.selectionEnd[1]||this.refresh(!0);}else this.refresh(!0);}},t.prototype._dragScroll=function(){if(this._model.selectionEnd&&this._model.selectionStart&&this._dragScrollAmount){this._onRequestScrollLines.fire({amount:this._dragScrollAmount,suppressScrollEvent:!1});var e=this._bufferService.buffer;this._dragScrollAmount>0?(3!==this._activeSelectionMode&&(this._model.selectionEnd[0]=this._bufferService.cols),this._model.selectionEnd[1]=Math.min(e.ydisp+this._bufferService.rows,e.lines.length-1)):(3!==this._activeSelectionMode&&(this._model.selectionEnd[0]=0),this._model.selectionEnd[1]=e.ydisp),this.refresh();}},t.prototype._onMouseUp=function(e){var t=e.timeStamp-this._mouseDownTimeStamp;if(this._removeMouseDownListeners(),this.selectionText.length<=1&&t<500&&e.altKey&&this._optionsService.getOption("altClickMovesCursor")){if(this._bufferService.buffer.ybase===this._bufferService.buffer.ydisp){var r=this._mouseService.getCoords(e,this._element,this._bufferService.cols,this._bufferService.rows,!1);if(r&&void 0!==r[0]&&void 0!==r[1]){var i=(0, d.moveToCellSequence)(r[0]-1,r[1]-1,this._bufferService,this._coreService.decPrivateModes.applicationCursorKeys);this._coreService.triggerDataEvent(i,!0);}}}else this._fireEventIfSelectionChanged();},t.prototype._fireEventIfSelectionChanged=function(){var e=this._model.finalSelectionStart,t=this._model.finalSelectionEnd,r=!(!e||!t||e[0]===t[0]&&e[1]===t[1]);r?e&&t&&(this._oldSelectionStart&&this._oldSelectionEnd&&e[0]===this._oldSelectionStart[0]&&e[1]===this._oldSelectionStart[1]&&t[0]===this._oldSelectionEnd[0]&&t[1]===this._oldSelectionEnd[1]||this._fireOnSelectionChange(e,t,r)):this._oldHasSelection&&this._fireOnSelectionChange(e,t,r);},t.prototype._fireOnSelectionChange=function(e,t,r){this._oldSelectionStart=e,this._oldSelectionEnd=t,this._oldHasSelection=r,this._onSelectionChange.fire();},t.prototype._onBufferActivate=function(e){var t=this;this.clearSelection(),this._trimListener.dispose(),this._trimListener=e.activeBuffer.lines.onTrim((function(e){return t._onTrim(e)}));},t.prototype._convertViewportColToCharacterIndex=function(e,t){for(var r=t[0],i=0;t[0]>=i;i++){var n=e.loadCell(i,this._workCell).getChars().length;0===this._workCell.getWidth()?r--:n>1&&t[0]!==i&&(r+=n-1);}return r},t.prototype.setSelection=function(e,t,r){this._model.clearSelection(),this._removeMouseDownListeners(),this._model.selectionStart=[e,t],this._model.selectionStartLength=r,this.refresh(),this._fireEventIfSelectionChanged();},t.prototype.rightClickSelect=function(e){this._isClickInSelection(e)||(this._selectWordAtCursor(e,!1)&&this.refresh(!0),this._fireEventIfSelectionChanged());},t.prototype._getWordAt=function(e,t,r,i){if(void 0===r&&(r=!0),void 0===i&&(i=!0),!(e[0]>=this._bufferService.cols)){var n=this._bufferService.buffer,o=n.lines.get(e[1]);if(o){var s=n.translateBufferLineToString(e[1],!1),a=this._convertViewportColToCharacterIndex(o,e),c=a,l=e[0]-a,h=0,u=0,f=0,_=0;if(" "===s.charAt(a)){for(;a>0&&" "===s.charAt(a-1);)a--;for(;c<s.length&&" "===s.charAt(c+1);)c++;}else {var d=e[0],p=e[0];0===o.getWidth(d)&&(h++,d--),2===o.getWidth(p)&&(u++,p++);var v=o.getString(p).length;for(v>1&&(_+=v-1,c+=v-1);d>0&&a>0&&!this._isCharWordSeparator(o.loadCell(d-1,this._workCell));){o.loadCell(d-1,this._workCell);var y=this._workCell.getChars().length;0===this._workCell.getWidth()?(h++,d--):y>1&&(f+=y-1,a-=y-1),a--,d--;}for(;p<o.length&&c+1<s.length&&!this._isCharWordSeparator(o.loadCell(p+1,this._workCell));){o.loadCell(p+1,this._workCell);var g=this._workCell.getChars().length;2===this._workCell.getWidth()?(u++,p++):g>1&&(_+=g-1,c+=g-1),c++,p++;}}c++;var m=a+l-h+f,b=Math.min(this._bufferService.cols,c-a+h+u-f-_);if(t||""!==s.slice(a,c).trim()){if(r&&0===m&&32!==o.getCodePoint(0)){var S=n.lines.get(e[1]-1);if(S&&o.isWrapped&&32!==S.getCodePoint(this._bufferService.cols-1)){var C=this._getWordAt([this._bufferService.cols-1,e[1]-1],!1,!0,!1);if(C){var w=this._bufferService.cols-C.start;m-=w,b+=w;}}}if(i&&m+b===this._bufferService.cols&&32!==o.getCodePoint(this._bufferService.cols-1)){var L=n.lines.get(e[1]+1);if((null==L?void 0:L.isWrapped)&&32!==L.getCodePoint(0)){var E=this._getWordAt([0,e[1]+1],!1,!1,!0);E&&(b+=E.length);}}return {start:m,length:b}}}}},t.prototype._selectWordAt=function(e,t){var r=this._getWordAt(e,t);if(r){for(;r.start<0;)r.start+=this._bufferService.cols,e[1]--;this._model.selectionStart=[r.start,e[1]],this._model.selectionStartLength=r.length;}},t.prototype._selectToWordAt=function(e){var t=this._getWordAt(e,!0);if(t){for(var r=e[1];t.start<0;)t.start+=this._bufferService.cols,r--;if(!this._model.areSelectionValuesReversed())for(;t.start+t.length>this._bufferService.cols;)t.length-=this._bufferService.cols,r++;this._model.selectionEnd=[this._model.areSelectionValuesReversed()?t.start:t.start+t.length,r];}},t.prototype._isCharWordSeparator=function(e){return 0!==e.getWidth()&&this._optionsService.rawOptions.wordSeparator.indexOf(e.getChars())>=0},t.prototype._selectLineAt=function(e){var t=this._bufferService.buffer.getWrappedRangeForLine(e),r={start:{x:0,y:t.first},end:{x:this._bufferService.cols-1,y:t.last}};this._model.selectionStart=[0,t.first],this._model.selectionEnd=void 0,this._model.selectionStartLength=(0, v.getRangeLength)(r,this._bufferService.cols);},o([s(3,f.IBufferService),s(4,f.ICoreService),s(5,u.IMouseService),s(6,f.IOptionsService),s(7,u.IRenderService)],t)}(p.Disposable);t.SelectionService=m;},4725:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.ICharacterJoinerService=t.ISoundService=t.ISelectionService=t.IRenderService=t.IMouseService=t.ICoreBrowserService=t.ICharSizeService=void 0;var i=r(8343);t.ICharSizeService=(0, i.createDecorator)("CharSizeService"),t.ICoreBrowserService=(0, i.createDecorator)("CoreBrowserService"),t.IMouseService=(0, i.createDecorator)("MouseService"),t.IRenderService=(0, i.createDecorator)("RenderService"),t.ISelectionService=(0, i.createDecorator)("SelectionService"),t.ISoundService=(0, i.createDecorator)("SoundService"),t.ICharacterJoinerService=(0, i.createDecorator)("CharacterJoinerService");},357:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.SoundService=void 0;var o=r(2585),s=function(){function e(e){this._optionsService=e;}return Object.defineProperty(e,"audioContext",{get:function(){if(!e._audioContext){var t=window.AudioContext||window.webkitAudioContext;if(!t)return console.warn("Web Audio API is not supported by this browser. Consider upgrading to the latest version"),null;e._audioContext=new t;}return e._audioContext},enumerable:!1,configurable:!0}),e.prototype.playBellSound=function(){var t=e.audioContext;if(t){var r=t.createBufferSource();t.decodeAudioData(this._base64ToArrayBuffer(this._removeMimeType(this._optionsService.rawOptions.bellSound)),(function(e){r.buffer=e,r.connect(t.destination),r.start(0);}));}},e.prototype._base64ToArrayBuffer=function(e){for(var t=window.atob(e),r=t.length,i=new Uint8Array(r),n=0;n<r;n++)i[n]=t.charCodeAt(n);return i.buffer},e.prototype._removeMimeType=function(e){return e.split(",")[1]},e=i([n(0,o.IOptionsService)],e)}();t.SoundService=s;},6349:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.CircularList=void 0;var i=r(8460),n=function(){function e(e){this._maxLength=e,this.onDeleteEmitter=new i.EventEmitter,this.onInsertEmitter=new i.EventEmitter,this.onTrimEmitter=new i.EventEmitter,this._array=new Array(this._maxLength),this._startIndex=0,this._length=0;}return Object.defineProperty(e.prototype,"onDelete",{get:function(){return this.onDeleteEmitter.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onInsert",{get:function(){return this.onInsertEmitter.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"onTrim",{get:function(){return this.onTrimEmitter.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"maxLength",{get:function(){return this._maxLength},set:function(e){if(this._maxLength!==e){for(var t=new Array(e),r=0;r<Math.min(e,this.length);r++)t[r]=this._array[this._getCyclicIndex(r)];this._array=t,this._maxLength=e,this._startIndex=0;}},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"length",{get:function(){return this._length},set:function(e){if(e>this._length)for(var t=this._length;t<e;t++)this._array[t]=void 0;this._length=e;},enumerable:!1,configurable:!0}),e.prototype.get=function(e){return this._array[this._getCyclicIndex(e)]},e.prototype.set=function(e,t){this._array[this._getCyclicIndex(e)]=t;},e.prototype.push=function(e){this._array[this._getCyclicIndex(this._length)]=e,this._length===this._maxLength?(this._startIndex=++this._startIndex%this._maxLength,this.onTrimEmitter.fire(1)):this._length++;},e.prototype.recycle=function(){if(this._length!==this._maxLength)throw new Error("Can only recycle when the buffer is full");return this._startIndex=++this._startIndex%this._maxLength,this.onTrimEmitter.fire(1),this._array[this._getCyclicIndex(this._length-1)]},Object.defineProperty(e.prototype,"isFull",{get:function(){return this._length===this._maxLength},enumerable:!1,configurable:!0}),e.prototype.pop=function(){return this._array[this._getCyclicIndex(this._length---1)]},e.prototype.splice=function(e,t){for(var r=[],i=2;i<arguments.length;i++)r[i-2]=arguments[i];if(t){for(var n=e;n<this._length-t;n++)this._array[this._getCyclicIndex(n)]=this._array[this._getCyclicIndex(n+t)];this._length-=t,this.onDeleteEmitter.fire({index:e,amount:t});}for(n=this._length-1;n>=e;n--)this._array[this._getCyclicIndex(n+r.length)]=this._array[this._getCyclicIndex(n)];for(n=0;n<r.length;n++)this._array[this._getCyclicIndex(e+n)]=r[n];if(r.length&&this.onInsertEmitter.fire({index:e,amount:r.length}),this._length+r.length>this._maxLength){var o=this._length+r.length-this._maxLength;this._startIndex+=o,this._length=this._maxLength,this.onTrimEmitter.fire(o);}else this._length+=r.length;},e.prototype.trimStart=function(e){e>this._length&&(e=this._length),this._startIndex+=e,this._length-=e,this.onTrimEmitter.fire(e);},e.prototype.shiftElements=function(e,t,r){if(!(t<=0)){if(e<0||e>=this._length)throw new Error("start argument out of range");if(e+r<0)throw new Error("Cannot shift elements in list beyond index 0");if(r>0){for(var i=t-1;i>=0;i--)this.set(e+i+r,this.get(e+i));var n=e+t+r-this._length;if(n>0)for(this._length+=n;this._length>this._maxLength;)this._length--,this._startIndex++,this.onTrimEmitter.fire(1);}else for(i=0;i<t;i++)this.set(e+i+r,this.get(e+i));}},e.prototype._getCyclicIndex=function(e){return (this._startIndex+e)%this._maxLength},e}();t.CircularList=n;},1439:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.clone=void 0,t.clone=function e(t,r){if(void 0===r&&(r=5),"object"!=typeof t)return t;var i=Array.isArray(t)?[]:{};for(var n in t)i[n]=r<=1?t[n]:t[n]&&e(t[n],r-1);return i};},8055:function(e,t){var r,i,n,o,s=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s};function a(e){var t=e.toString(16);return t.length<2?"0"+t:t}function c(e,t){return e<t?(t+.05)/(e+.05):(e+.05)/(t+.05)}Object.defineProperty(t,"__esModule",{value:!0}),t.contrastRatio=t.toPaddedHex=t.rgba=t.rgb=t.css=t.color=t.channels=void 0,function(e){e.toCss=function(e,t,r,i){return void 0!==i?"#"+a(e)+a(t)+a(r)+a(i):"#"+a(e)+a(t)+a(r)},e.toRgba=function(e,t,r,i){return void 0===i&&(i=255),(e<<24|t<<16|r<<8|i)>>>0};}(r=t.channels||(t.channels={})),(i=t.color||(t.color={})).blend=function(e,t){var i=(255&t.rgba)/255;if(1===i)return {css:t.css,rgba:t.rgba};var n=t.rgba>>24&255,o=t.rgba>>16&255,s=t.rgba>>8&255,a=e.rgba>>24&255,c=e.rgba>>16&255,l=e.rgba>>8&255,h=a+Math.round((n-a)*i),u=c+Math.round((o-c)*i),f=l+Math.round((s-l)*i);return {css:r.toCss(h,u,f),rgba:r.toRgba(h,u,f)}},i.isOpaque=function(e){return 255==(255&e.rgba)},i.ensureContrastRatio=function(e,t,r){var i=o.ensureContrastRatio(e.rgba,t.rgba,r);if(i)return o.toColor(i>>24&255,i>>16&255,i>>8&255)},i.opaque=function(e){var t=(255|e.rgba)>>>0,i=s(o.toChannels(t),3),n=i[0],a=i[1],c=i[2];return {css:r.toCss(n,a,c),rgba:t}},i.opacity=function(e,t){var i=Math.round(255*t),n=s(o.toChannels(e.rgba),3),a=n[0],c=n[1],l=n[2];return {css:r.toCss(a,c,l,i),rgba:r.toRgba(a,c,l,i)}},i.toColorRGB=function(e){return [e.rgba>>24&255,e.rgba>>16&255,e.rgba>>8&255]},(t.css||(t.css={})).toColor=function(e){if(e.match(/#[0-9a-f]{3,8}/i))switch(e.length){case 4:var t=parseInt(e.slice(1,2).repeat(2),16),r=parseInt(e.slice(2,3).repeat(2),16),i=parseInt(e.slice(3,4).repeat(2),16);return o.toColor(t,r,i);case 5:t=parseInt(e.slice(1,2).repeat(2),16),r=parseInt(e.slice(2,3).repeat(2),16),i=parseInt(e.slice(3,4).repeat(2),16);var n=parseInt(e.slice(4,5).repeat(2),16);return o.toColor(t,r,i,n);case 7:return {css:e,rgba:(parseInt(e.slice(1),16)<<8|255)>>>0};case 9:return {css:e,rgba:parseInt(e.slice(1),16)>>>0}}var s=e.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/);if(s)return t=parseInt(s[1]),r=parseInt(s[2]),i=parseInt(s[3]),n=Math.round(255*(void 0===s[5]?1:parseFloat(s[5]))),o.toColor(t,r,i,n);throw new Error("css.toColor: Unsupported css format")},function(e){function t(e,t,r){var i=e/255,n=t/255,o=r/255;return .2126*(i<=.03928?i/12.92:Math.pow((i+.055)/1.055,2.4))+.7152*(n<=.03928?n/12.92:Math.pow((n+.055)/1.055,2.4))+.0722*(o<=.03928?o/12.92:Math.pow((o+.055)/1.055,2.4))}e.relativeLuminance=function(e){return t(e>>16&255,e>>8&255,255&e)},e.relativeLuminance2=t;}(n=t.rgb||(t.rgb={})),function(e){function t(e,t,r){for(var i=e>>24&255,o=e>>16&255,s=e>>8&255,a=t>>24&255,l=t>>16&255,h=t>>8&255,u=c(n.relativeLuminance2(a,l,h),n.relativeLuminance2(i,o,s));u<r&&(a>0||l>0||h>0);)a-=Math.max(0,Math.ceil(.1*a)),l-=Math.max(0,Math.ceil(.1*l)),h-=Math.max(0,Math.ceil(.1*h)),u=c(n.relativeLuminance2(a,l,h),n.relativeLuminance2(i,o,s));return (a<<24|l<<16|h<<8|255)>>>0}function i(e,t,r){for(var i=e>>24&255,o=e>>16&255,s=e>>8&255,a=t>>24&255,l=t>>16&255,h=t>>8&255,u=c(n.relativeLuminance2(a,l,h),n.relativeLuminance2(i,o,s));u<r&&(a<255||l<255||h<255);)a=Math.min(255,a+Math.ceil(.1*(255-a))),l=Math.min(255,l+Math.ceil(.1*(255-l))),h=Math.min(255,h+Math.ceil(.1*(255-h))),u=c(n.relativeLuminance2(a,l,h),n.relativeLuminance2(i,o,s));return (a<<24|l<<16|h<<8|255)>>>0}e.ensureContrastRatio=function(e,r,o){var s=n.relativeLuminance(e>>8),a=n.relativeLuminance(r>>8);if(c(s,a)<o){if(a<s){var l=t(e,r,o),h=c(s,n.relativeLuminance(l>>8));if(h<o){var u=i(e,e,o);return h>c(s,n.relativeLuminance(u>>8))?l:u}return l}var f=i(e,r,o),_=c(s,n.relativeLuminance(f>>8));return _<o?(u=t(e,e,o),_>c(s,n.relativeLuminance(u>>8))?f:u):f}},e.reduceLuminance=t,e.increaseLuminance=i,e.toChannels=function(e){return [e>>24&255,e>>16&255,e>>8&255,255&e]},e.toColor=function(e,t,i,n){return {css:r.toCss(e,t,i,n),rgba:r.toRgba(e,t,i,n)}};}(o=t.rgba||(t.rgba={})),t.toPaddedHex=a,t.contrastRatio=c;},8969:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.CoreTerminal=void 0;var s=r(844),a=r(2585),c=r(4348),l=r(7866),h=r(744),u=r(7302),f=r(6975),_=r(8460),d=r(1753),p=r(3730),v=r(1480),y=r(7994),g=r(9282),m=r(5435),b=r(5981),S=!1,C=function(e){function t(t){var r=e.call(this)||this;return r._onBinary=new _.EventEmitter,r._onData=new _.EventEmitter,r._onLineFeed=new _.EventEmitter,r._onResize=new _.EventEmitter,r._onScroll=new _.EventEmitter,r._onWriteParsed=new _.EventEmitter,r._instantiationService=new c.InstantiationService,r.optionsService=new u.OptionsService(t),r._instantiationService.setService(a.IOptionsService,r.optionsService),r._bufferService=r.register(r._instantiationService.createInstance(h.BufferService)),r._instantiationService.setService(a.IBufferService,r._bufferService),r._logService=r._instantiationService.createInstance(l.LogService),r._instantiationService.setService(a.ILogService,r._logService),r.coreService=r.register(r._instantiationService.createInstance(f.CoreService,(function(){return r.scrollToBottom()}))),r._instantiationService.setService(a.ICoreService,r.coreService),r.coreMouseService=r._instantiationService.createInstance(d.CoreMouseService),r._instantiationService.setService(a.ICoreMouseService,r.coreMouseService),r._dirtyRowService=r._instantiationService.createInstance(p.DirtyRowService),r._instantiationService.setService(a.IDirtyRowService,r._dirtyRowService),r.unicodeService=r._instantiationService.createInstance(v.UnicodeService),r._instantiationService.setService(a.IUnicodeService,r.unicodeService),r._charsetService=r._instantiationService.createInstance(y.CharsetService),r._instantiationService.setService(a.ICharsetService,r._charsetService),r._inputHandler=new m.InputHandler(r._bufferService,r._charsetService,r.coreService,r._dirtyRowService,r._logService,r.optionsService,r.coreMouseService,r.unicodeService),r.register((0, _.forwardEvent)(r._inputHandler.onLineFeed,r._onLineFeed)),r.register(r._inputHandler),r.register((0, _.forwardEvent)(r._bufferService.onResize,r._onResize)),r.register((0, _.forwardEvent)(r.coreService.onData,r._onData)),r.register((0, _.forwardEvent)(r.coreService.onBinary,r._onBinary)),r.register(r.optionsService.onOptionChange((function(e){return r._updateOptions(e)}))),r.register(r._bufferService.onScroll((function(e){r._onScroll.fire({position:r._bufferService.buffer.ydisp,source:0}),r._dirtyRowService.markRangeDirty(r._bufferService.buffer.scrollTop,r._bufferService.buffer.scrollBottom);}))),r.register(r._inputHandler.onScroll((function(e){r._onScroll.fire({position:r._bufferService.buffer.ydisp,source:0}),r._dirtyRowService.markRangeDirty(r._bufferService.buffer.scrollTop,r._bufferService.buffer.scrollBottom);}))),r._writeBuffer=new b.WriteBuffer((function(e,t){return r._inputHandler.parse(e,t)})),r.register((0, _.forwardEvent)(r._writeBuffer.onWriteParsed,r._onWriteParsed)),r}return n(t,e),Object.defineProperty(t.prototype,"onBinary",{get:function(){return this._onBinary.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onData",{get:function(){return this._onData.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onLineFeed",{get:function(){return this._onLineFeed.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onResize",{get:function(){return this._onResize.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onWriteParsed",{get:function(){return this._onWriteParsed.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onScroll",{get:function(){var e=this;return this._onScrollApi||(this._onScrollApi=new _.EventEmitter,this.register(this._onScroll.event((function(t){var r;null===(r=e._onScrollApi)||void 0===r||r.fire(t.position);})))),this._onScrollApi.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"cols",{get:function(){return this._bufferService.cols},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"rows",{get:function(){return this._bufferService.rows},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"buffers",{get:function(){return this._bufferService.buffers},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"options",{get:function(){return this.optionsService.options},set:function(e){for(var t in e)this.optionsService.options[t]=e[t];},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){var t;this._isDisposed||(e.prototype.dispose.call(this),null===(t=this._windowsMode)||void 0===t||t.dispose(),this._windowsMode=void 0);},t.prototype.write=function(e,t){this._writeBuffer.write(e,t);},t.prototype.writeSync=function(e,t){this._logService.logLevel<=a.LogLevelEnum.WARN&&!S&&(this._logService.warn("writeSync is unreliable and will be removed soon."),S=!0),this._writeBuffer.writeSync(e,t);},t.prototype.resize=function(e,t){isNaN(e)||isNaN(t)||(e=Math.max(e,h.MINIMUM_COLS),t=Math.max(t,h.MINIMUM_ROWS),this._bufferService.resize(e,t));},t.prototype.scroll=function(e,t){void 0===t&&(t=!1),this._bufferService.scroll(e,t);},t.prototype.scrollLines=function(e,t,r){this._bufferService.scrollLines(e,t,r);},t.prototype.scrollPages=function(e){this._bufferService.scrollPages(e);},t.prototype.scrollToTop=function(){this._bufferService.scrollToTop();},t.prototype.scrollToBottom=function(){this._bufferService.scrollToBottom();},t.prototype.scrollToLine=function(e){this._bufferService.scrollToLine(e);},t.prototype.registerEscHandler=function(e,t){return this._inputHandler.registerEscHandler(e,t)},t.prototype.registerDcsHandler=function(e,t){return this._inputHandler.registerDcsHandler(e,t)},t.prototype.registerCsiHandler=function(e,t){return this._inputHandler.registerCsiHandler(e,t)},t.prototype.registerOscHandler=function(e,t){return this._inputHandler.registerOscHandler(e,t)},t.prototype._setup=function(){this.optionsService.rawOptions.windowsMode&&this._enableWindowsMode();},t.prototype.reset=function(){this._inputHandler.reset(),this._bufferService.reset(),this._charsetService.reset(),this.coreService.reset(),this.coreMouseService.reset();},t.prototype._updateOptions=function(e){var t;switch(e){case"scrollback":this.buffers.resize(this.cols,this.rows);break;case"windowsMode":this.optionsService.rawOptions.windowsMode?this._enableWindowsMode():(null===(t=this._windowsMode)||void 0===t||t.dispose(),this._windowsMode=void 0);}},t.prototype._enableWindowsMode=function(){var e=this;if(!this._windowsMode){var t=[];t.push(this.onLineFeed(g.updateWindowsModeWrappedState.bind(null,this._bufferService))),t.push(this.registerCsiHandler({final:"H"},(function(){return (0, g.updateWindowsModeWrappedState)(e._bufferService),!1}))),this._windowsMode={dispose:function(){var e,r;try{for(var i=o(t),n=i.next();!n.done;n=i.next())n.value.dispose();}catch(t){e={error:t};}finally{try{n&&!n.done&&(r=i.return)&&r.call(i);}finally{if(e)throw e.error}}}};}},t}(s.Disposable);t.CoreTerminal=C;},8460:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.forwardEvent=t.EventEmitter=void 0;var r=function(){function e(){this._listeners=[],this._disposed=!1;}return Object.defineProperty(e.prototype,"event",{get:function(){var e=this;return this._event||(this._event=function(t){return e._listeners.push(t),{dispose:function(){if(!e._disposed)for(var r=0;r<e._listeners.length;r++)if(e._listeners[r]===t)return void e._listeners.splice(r,1)}}}),this._event},enumerable:!1,configurable:!0}),e.prototype.fire=function(e,t){for(var r=[],i=0;i<this._listeners.length;i++)r.push(this._listeners[i]);for(i=0;i<r.length;i++)r[i].call(void 0,e,t);},e.prototype.dispose=function(){this._listeners&&(this._listeners.length=0),this._disposed=!0;},e}();t.EventEmitter=r,t.forwardEvent=function(e,t){return e((function(e){return t.fire(e)}))};},5435:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.InputHandler=t.WindowsOptionsReportType=void 0;var o,s=r(2584),a=r(7116),c=r(2015),l=r(844),h=r(8273),u=r(482),f=r(8437),_=r(8460),d=r(643),p=r(511),v=r(3734),y=r(2585),g=r(6242),m=r(6351),b=r(5941),S={"(":0,")":1,"*":2,"+":3,"-":1,".":2},C=131072;function w(e,t){if(e>24)return t.setWinLines||!1;switch(e){case 1:return !!t.restoreWin;case 2:return !!t.minimizeWin;case 3:return !!t.setWinPosition;case 4:return !!t.setWinSizePixels;case 5:return !!t.raiseWin;case 6:return !!t.lowerWin;case 7:return !!t.refreshWin;case 8:return !!t.setWinSizeChars;case 9:return !!t.maximizeWin;case 10:return !!t.fullscreenWin;case 11:return !!t.getWinState;case 13:return !!t.getWinPosition;case 14:return !!t.getWinSizePixels;case 15:return !!t.getScreenSizePixels;case 16:return !!t.getCellSizePixels;case 18:return !!t.getWinSizeChars;case 19:return !!t.getScreenSizeChars;case 20:return !!t.getIconTitle;case 21:return !!t.getWinTitle;case 22:return !!t.pushTitle;case 23:return !!t.popTitle;case 24:return !!t.setWinLines}return !1}!function(e){e[e.GET_WIN_SIZE_PIXELS=0]="GET_WIN_SIZE_PIXELS",e[e.GET_CELL_SIZE_PIXELS=1]="GET_CELL_SIZE_PIXELS";}(o=t.WindowsOptionsReportType||(t.WindowsOptionsReportType={}));var L=function(){function e(e,t,r,i){this._bufferService=e,this._coreService=t,this._logService=r,this._optionsService=i,this._data=new Uint32Array(0);}return e.prototype.hook=function(e){this._data=new Uint32Array(0);},e.prototype.put=function(e,t,r){this._data=(0, h.concat)(this._data,e.subarray(t,r));},e.prototype.unhook=function(e){if(!e)return this._data=new Uint32Array(0),!0;var t=(0, u.utf32ToString)(this._data);switch(this._data=new Uint32Array(0),t){case'"q':this._coreService.triggerDataEvent(s.C0.ESC+'P1$r0"q'+s.C0.ESC+"\\");break;case'"p':this._coreService.triggerDataEvent(s.C0.ESC+'P1$r61;1"p'+s.C0.ESC+"\\");break;case"r":var r=this._bufferService.buffer.scrollTop+1+";"+(this._bufferService.buffer.scrollBottom+1)+"r";this._coreService.triggerDataEvent(s.C0.ESC+"P1$r"+r+s.C0.ESC+"\\");break;case"m":this._coreService.triggerDataEvent(s.C0.ESC+"P1$r0m"+s.C0.ESC+"\\");break;case" q":var i={block:2,underline:4,bar:6}[this._optionsService.rawOptions.cursorStyle];i-=this._optionsService.rawOptions.cursorBlink?1:0,this._coreService.triggerDataEvent(s.C0.ESC+"P1$r"+i+" q"+s.C0.ESC+"\\");break;default:this._logService.debug("Unknown DCS $q %s",t),this._coreService.triggerDataEvent(s.C0.ESC+"P0$r"+s.C0.ESC+"\\");}return !0},e}(),E=function(e){function t(t,r,i,n,o,l,h,d,v){void 0===v&&(v=new c.EscapeSequenceParser);var y=e.call(this)||this;y._bufferService=t,y._charsetService=r,y._coreService=i,y._dirtyRowService=n,y._logService=o,y._optionsService=l,y._coreMouseService=h,y._unicodeService=d,y._parser=v,y._parseBuffer=new Uint32Array(4096),y._stringDecoder=new u.StringToUtf32,y._utf8Decoder=new u.Utf8ToUtf32,y._workCell=new p.CellData,y._windowTitle="",y._iconName="",y._windowTitleStack=[],y._iconNameStack=[],y._curAttrData=f.DEFAULT_ATTR_DATA.clone(),y._eraseAttrDataInternal=f.DEFAULT_ATTR_DATA.clone(),y._onRequestBell=new _.EventEmitter,y._onRequestRefreshRows=new _.EventEmitter,y._onRequestReset=new _.EventEmitter,y._onRequestSendFocus=new _.EventEmitter,y._onRequestSyncScrollBar=new _.EventEmitter,y._onRequestWindowsOptionsReport=new _.EventEmitter,y._onA11yChar=new _.EventEmitter,y._onA11yTab=new _.EventEmitter,y._onCursorMove=new _.EventEmitter,y._onLineFeed=new _.EventEmitter,y._onScroll=new _.EventEmitter,y._onTitleChange=new _.EventEmitter,y._onColor=new _.EventEmitter,y._parseStack={paused:!1,cursorStartX:0,cursorStartY:0,decodedLength:0,position:0},y._specialColors=[256,257,258],y.register(y._parser),y._activeBuffer=y._bufferService.buffer,y.register(y._bufferService.buffers.onBufferActivate((function(e){return y._activeBuffer=e.activeBuffer}))),y._parser.setCsiHandlerFallback((function(e,t){y._logService.debug("Unknown CSI code: ",{identifier:y._parser.identToString(e),params:t.toArray()});})),y._parser.setEscHandlerFallback((function(e){y._logService.debug("Unknown ESC code: ",{identifier:y._parser.identToString(e)});})),y._parser.setExecuteHandlerFallback((function(e){y._logService.debug("Unknown EXECUTE code: ",{code:e});})),y._parser.setOscHandlerFallback((function(e,t,r){y._logService.debug("Unknown OSC code: ",{identifier:e,action:t,data:r});})),y._parser.setDcsHandlerFallback((function(e,t,r){"HOOK"===t&&(r=r.toArray()),y._logService.debug("Unknown DCS code: ",{identifier:y._parser.identToString(e),action:t,payload:r});})),y._parser.setPrintHandler((function(e,t,r){return y.print(e,t,r)})),y._parser.registerCsiHandler({final:"@"},(function(e){return y.insertChars(e)})),y._parser.registerCsiHandler({intermediates:" ",final:"@"},(function(e){return y.scrollLeft(e)})),y._parser.registerCsiHandler({final:"A"},(function(e){return y.cursorUp(e)})),y._parser.registerCsiHandler({intermediates:" ",final:"A"},(function(e){return y.scrollRight(e)})),y._parser.registerCsiHandler({final:"B"},(function(e){return y.cursorDown(e)})),y._parser.registerCsiHandler({final:"C"},(function(e){return y.cursorForward(e)})),y._parser.registerCsiHandler({final:"D"},(function(e){return y.cursorBackward(e)})),y._parser.registerCsiHandler({final:"E"},(function(e){return y.cursorNextLine(e)})),y._parser.registerCsiHandler({final:"F"},(function(e){return y.cursorPrecedingLine(e)})),y._parser.registerCsiHandler({final:"G"},(function(e){return y.cursorCharAbsolute(e)})),y._parser.registerCsiHandler({final:"H"},(function(e){return y.cursorPosition(e)})),y._parser.registerCsiHandler({final:"I"},(function(e){return y.cursorForwardTab(e)})),y._parser.registerCsiHandler({final:"J"},(function(e){return y.eraseInDisplay(e)})),y._parser.registerCsiHandler({prefix:"?",final:"J"},(function(e){return y.eraseInDisplay(e)})),y._parser.registerCsiHandler({final:"K"},(function(e){return y.eraseInLine(e)})),y._parser.registerCsiHandler({prefix:"?",final:"K"},(function(e){return y.eraseInLine(e)})),y._parser.registerCsiHandler({final:"L"},(function(e){return y.insertLines(e)})),y._parser.registerCsiHandler({final:"M"},(function(e){return y.deleteLines(e)})),y._parser.registerCsiHandler({final:"P"},(function(e){return y.deleteChars(e)})),y._parser.registerCsiHandler({final:"S"},(function(e){return y.scrollUp(e)})),y._parser.registerCsiHandler({final:"T"},(function(e){return y.scrollDown(e)})),y._parser.registerCsiHandler({final:"X"},(function(e){return y.eraseChars(e)})),y._parser.registerCsiHandler({final:"Z"},(function(e){return y.cursorBackwardTab(e)})),y._parser.registerCsiHandler({final:"`"},(function(e){return y.charPosAbsolute(e)})),y._parser.registerCsiHandler({final:"a"},(function(e){return y.hPositionRelative(e)})),y._parser.registerCsiHandler({final:"b"},(function(e){return y.repeatPrecedingCharacter(e)})),y._parser.registerCsiHandler({final:"c"},(function(e){return y.sendDeviceAttributesPrimary(e)})),y._parser.registerCsiHandler({prefix:">",final:"c"},(function(e){return y.sendDeviceAttributesSecondary(e)})),y._parser.registerCsiHandler({final:"d"},(function(e){return y.linePosAbsolute(e)})),y._parser.registerCsiHandler({final:"e"},(function(e){return y.vPositionRelative(e)})),y._parser.registerCsiHandler({final:"f"},(function(e){return y.hVPosition(e)})),y._parser.registerCsiHandler({final:"g"},(function(e){return y.tabClear(e)})),y._parser.registerCsiHandler({final:"h"},(function(e){return y.setMode(e)})),y._parser.registerCsiHandler({prefix:"?",final:"h"},(function(e){return y.setModePrivate(e)})),y._parser.registerCsiHandler({final:"l"},(function(e){return y.resetMode(e)})),y._parser.registerCsiHandler({prefix:"?",final:"l"},(function(e){return y.resetModePrivate(e)})),y._parser.registerCsiHandler({final:"m"},(function(e){return y.charAttributes(e)})),y._parser.registerCsiHandler({final:"n"},(function(e){return y.deviceStatus(e)})),y._parser.registerCsiHandler({prefix:"?",final:"n"},(function(e){return y.deviceStatusPrivate(e)})),y._parser.registerCsiHandler({intermediates:"!",final:"p"},(function(e){return y.softReset(e)})),y._parser.registerCsiHandler({intermediates:" ",final:"q"},(function(e){return y.setCursorStyle(e)})),y._parser.registerCsiHandler({final:"r"},(function(e){return y.setScrollRegion(e)})),y._parser.registerCsiHandler({final:"s"},(function(e){return y.saveCursor(e)})),y._parser.registerCsiHandler({final:"t"},(function(e){return y.windowOptions(e)})),y._parser.registerCsiHandler({final:"u"},(function(e){return y.restoreCursor(e)})),y._parser.registerCsiHandler({intermediates:"'",final:"}"},(function(e){return y.insertColumns(e)})),y._parser.registerCsiHandler({intermediates:"'",final:"~"},(function(e){return y.deleteColumns(e)})),y._parser.setExecuteHandler(s.C0.BEL,(function(){return y.bell()})),y._parser.setExecuteHandler(s.C0.LF,(function(){return y.lineFeed()})),y._parser.setExecuteHandler(s.C0.VT,(function(){return y.lineFeed()})),y._parser.setExecuteHandler(s.C0.FF,(function(){return y.lineFeed()})),y._parser.setExecuteHandler(s.C0.CR,(function(){return y.carriageReturn()})),y._parser.setExecuteHandler(s.C0.BS,(function(){return y.backspace()})),y._parser.setExecuteHandler(s.C0.HT,(function(){return y.tab()})),y._parser.setExecuteHandler(s.C0.SO,(function(){return y.shiftOut()})),y._parser.setExecuteHandler(s.C0.SI,(function(){return y.shiftIn()})),y._parser.setExecuteHandler(s.C1.IND,(function(){return y.index()})),y._parser.setExecuteHandler(s.C1.NEL,(function(){return y.nextLine()})),y._parser.setExecuteHandler(s.C1.HTS,(function(){return y.tabSet()})),y._parser.registerOscHandler(0,new g.OscHandler((function(e){return y.setTitle(e),y.setIconName(e),!0}))),y._parser.registerOscHandler(1,new g.OscHandler((function(e){return y.setIconName(e)}))),y._parser.registerOscHandler(2,new g.OscHandler((function(e){return y.setTitle(e)}))),y._parser.registerOscHandler(4,new g.OscHandler((function(e){return y.setOrReportIndexedColor(e)}))),y._parser.registerOscHandler(10,new g.OscHandler((function(e){return y.setOrReportFgColor(e)}))),y._parser.registerOscHandler(11,new g.OscHandler((function(e){return y.setOrReportBgColor(e)}))),y._parser.registerOscHandler(12,new g.OscHandler((function(e){return y.setOrReportCursorColor(e)}))),y._parser.registerOscHandler(104,new g.OscHandler((function(e){return y.restoreIndexedColor(e)}))),y._parser.registerOscHandler(110,new g.OscHandler((function(e){return y.restoreFgColor(e)}))),y._parser.registerOscHandler(111,new g.OscHandler((function(e){return y.restoreBgColor(e)}))),y._parser.registerOscHandler(112,new g.OscHandler((function(e){return y.restoreCursorColor(e)}))),y._parser.registerEscHandler({final:"7"},(function(){return y.saveCursor()})),y._parser.registerEscHandler({final:"8"},(function(){return y.restoreCursor()})),y._parser.registerEscHandler({final:"D"},(function(){return y.index()})),y._parser.registerEscHandler({final:"E"},(function(){return y.nextLine()})),y._parser.registerEscHandler({final:"H"},(function(){return y.tabSet()})),y._parser.registerEscHandler({final:"M"},(function(){return y.reverseIndex()})),y._parser.registerEscHandler({final:"="},(function(){return y.keypadApplicationMode()})),y._parser.registerEscHandler({final:">"},(function(){return y.keypadNumericMode()})),y._parser.registerEscHandler({final:"c"},(function(){return y.fullReset()})),y._parser.registerEscHandler({final:"n"},(function(){return y.setgLevel(2)})),y._parser.registerEscHandler({final:"o"},(function(){return y.setgLevel(3)})),y._parser.registerEscHandler({final:"|"},(function(){return y.setgLevel(3)})),y._parser.registerEscHandler({final:"}"},(function(){return y.setgLevel(2)})),y._parser.registerEscHandler({final:"~"},(function(){return y.setgLevel(1)})),y._parser.registerEscHandler({intermediates:"%",final:"@"},(function(){return y.selectDefaultCharset()})),y._parser.registerEscHandler({intermediates:"%",final:"G"},(function(){return y.selectDefaultCharset()}));var m=function(e){b._parser.registerEscHandler({intermediates:"(",final:e},(function(){return y.selectCharset("("+e)})),b._parser.registerEscHandler({intermediates:")",final:e},(function(){return y.selectCharset(")"+e)})),b._parser.registerEscHandler({intermediates:"*",final:e},(function(){return y.selectCharset("*"+e)})),b._parser.registerEscHandler({intermediates:"+",final:e},(function(){return y.selectCharset("+"+e)})),b._parser.registerEscHandler({intermediates:"-",final:e},(function(){return y.selectCharset("-"+e)})),b._parser.registerEscHandler({intermediates:".",final:e},(function(){return y.selectCharset("."+e)})),b._parser.registerEscHandler({intermediates:"/",final:e},(function(){return y.selectCharset("/"+e)}));},b=this;for(var S in a.CHARSETS)m(S);return y._parser.registerEscHandler({intermediates:"#",final:"8"},(function(){return y.screenAlignmentPattern()})),y._parser.setErrorHandler((function(e){return y._logService.error("Parsing error: ",e),e})),y._parser.registerDcsHandler({intermediates:"$",final:"q"},new L(y._bufferService,y._coreService,y._logService,y._optionsService)),y}return n(t,e),Object.defineProperty(t.prototype,"onRequestBell",{get:function(){return this._onRequestBell.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestRefreshRows",{get:function(){return this._onRequestRefreshRows.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestReset",{get:function(){return this._onRequestReset.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestSendFocus",{get:function(){return this._onRequestSendFocus.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestSyncScrollBar",{get:function(){return this._onRequestSyncScrollBar.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onRequestWindowsOptionsReport",{get:function(){return this._onRequestWindowsOptionsReport.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onA11yChar",{get:function(){return this._onA11yChar.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onA11yTab",{get:function(){return this._onA11yTab.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onCursorMove",{get:function(){return this._onCursorMove.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onLineFeed",{get:function(){return this._onLineFeed.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onScroll",{get:function(){return this._onScroll.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onTitleChange",{get:function(){return this._onTitleChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onColor",{get:function(){return this._onColor.event},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){e.prototype.dispose.call(this);},t.prototype._preserveStack=function(e,t,r,i){this._parseStack.paused=!0,this._parseStack.cursorStartX=e,this._parseStack.cursorStartY=t,this._parseStack.decodedLength=r,this._parseStack.position=i;},t.prototype._logSlowResolvingAsync=function(e){this._logService.logLevel<=y.LogLevelEnum.WARN&&Promise.race([e,new Promise((function(e,t){return setTimeout((function(){return t("#SLOW_TIMEOUT")}),5e3)}))]).catch((function(e){if("#SLOW_TIMEOUT"!==e)throw e;console.warn("async parser handler taking longer than 5000 ms");}));},t.prototype.parse=function(e,t){var r,i=this._activeBuffer.x,n=this._activeBuffer.y,o=0,s=this._parseStack.paused;if(s){if(r=this._parser.parse(this._parseBuffer,this._parseStack.decodedLength,t))return this._logSlowResolvingAsync(r),r;i=this._parseStack.cursorStartX,n=this._parseStack.cursorStartY,this._parseStack.paused=!1,e.length>C&&(o=this._parseStack.position+C);}if(this._logService.logLevel<=y.LogLevelEnum.DEBUG&&this._logService.debug("parsing data"+("string"==typeof e?' "'+e+'"':' "'+Array.prototype.map.call(e,(function(e){return String.fromCharCode(e)})).join("")+'"'),"string"==typeof e?e.split("").map((function(e){return e.charCodeAt(0)})):e),this._parseBuffer.length<e.length&&this._parseBuffer.length<C&&(this._parseBuffer=new Uint32Array(Math.min(e.length,C))),s||this._dirtyRowService.clearRange(),e.length>C)for(var a=o;a<e.length;a+=C){var c=a+C<e.length?a+C:e.length,l="string"==typeof e?this._stringDecoder.decode(e.substring(a,c),this._parseBuffer):this._utf8Decoder.decode(e.subarray(a,c),this._parseBuffer);if(r=this._parser.parse(this._parseBuffer,l))return this._preserveStack(i,n,l,a),this._logSlowResolvingAsync(r),r}else if(!s&&(l="string"==typeof e?this._stringDecoder.decode(e,this._parseBuffer):this._utf8Decoder.decode(e,this._parseBuffer),r=this._parser.parse(this._parseBuffer,l)))return this._preserveStack(i,n,l,0),this._logSlowResolvingAsync(r),r;this._activeBuffer.x===i&&this._activeBuffer.y===n||this._onCursorMove.fire(),this._onRequestRefreshRows.fire(this._dirtyRowService.start,this._dirtyRowService.end);},t.prototype.print=function(e,t,r){var i,n,o=this._charsetService.charset,s=this._optionsService.rawOptions.screenReaderMode,a=this._bufferService.cols,c=this._coreService.decPrivateModes.wraparound,l=this._coreService.modes.insertMode,h=this._curAttrData,f=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y);this._dirtyRowService.markDirty(this._activeBuffer.y),this._activeBuffer.x&&r-t>0&&2===f.getWidth(this._activeBuffer.x-1)&&f.setCellFromCodePoint(this._activeBuffer.x-1,0,1,h.fg,h.bg,h.extended);for(var _=t;_<r;++_){if(i=e[_],n=this._unicodeService.wcwidth(i),i<127&&o){var p=o[String.fromCharCode(i)];p&&(i=p.charCodeAt(0));}if(s&&this._onA11yChar.fire((0, u.stringFromCodePoint)(i)),n||!this._activeBuffer.x){if(this._activeBuffer.x+n-1>=a)if(c){for(;this._activeBuffer.x<a;)f.setCellFromCodePoint(this._activeBuffer.x++,0,1,h.fg,h.bg,h.extended);this._activeBuffer.x=0,this._activeBuffer.y++,this._activeBuffer.y===this._activeBuffer.scrollBottom+1?(this._activeBuffer.y--,this._bufferService.scroll(this._eraseAttrData(),!0)):(this._activeBuffer.y>=this._bufferService.rows&&(this._activeBuffer.y=this._bufferService.rows-1),this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y).isWrapped=!0),f=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y);}else if(this._activeBuffer.x=a-1,2===n)continue;if(l&&(f.insertCells(this._activeBuffer.x,n,this._activeBuffer.getNullCell(h),h),2===f.getWidth(a-1)&&f.setCellFromCodePoint(a-1,d.NULL_CELL_CODE,d.NULL_CELL_WIDTH,h.fg,h.bg,h.extended)),f.setCellFromCodePoint(this._activeBuffer.x++,i,n,h.fg,h.bg,h.extended),n>0)for(;--n;)f.setCellFromCodePoint(this._activeBuffer.x++,0,0,h.fg,h.bg,h.extended);}else f.getWidth(this._activeBuffer.x-1)?f.addCodepointToCell(this._activeBuffer.x-1,i):f.addCodepointToCell(this._activeBuffer.x-2,i);}r-t>0&&(f.loadCell(this._activeBuffer.x-1,this._workCell),2===this._workCell.getWidth()||this._workCell.getCode()>65535?this._parser.precedingCodepoint=0:this._workCell.isCombined()?this._parser.precedingCodepoint=this._workCell.getChars().charCodeAt(0):this._parser.precedingCodepoint=this._workCell.content),this._activeBuffer.x<a&&r-t>0&&0===f.getWidth(this._activeBuffer.x)&&!f.hasContent(this._activeBuffer.x)&&f.setCellFromCodePoint(this._activeBuffer.x,0,1,h.fg,h.bg,h.extended),this._dirtyRowService.markDirty(this._activeBuffer.y);},t.prototype.registerCsiHandler=function(e,t){var r=this;return "t"!==e.final||e.prefix||e.intermediates?this._parser.registerCsiHandler(e,t):this._parser.registerCsiHandler(e,(function(e){return !w(e.params[0],r._optionsService.rawOptions.windowOptions)||t(e)}))},t.prototype.registerDcsHandler=function(e,t){return this._parser.registerDcsHandler(e,new m.DcsHandler(t))},t.prototype.registerEscHandler=function(e,t){return this._parser.registerEscHandler(e,t)},t.prototype.registerOscHandler=function(e,t){return this._parser.registerOscHandler(e,new g.OscHandler(t))},t.prototype.bell=function(){return this._onRequestBell.fire(),!0},t.prototype.lineFeed=function(){return this._dirtyRowService.markDirty(this._activeBuffer.y),this._optionsService.rawOptions.convertEol&&(this._activeBuffer.x=0),this._activeBuffer.y++,this._activeBuffer.y===this._activeBuffer.scrollBottom+1?(this._activeBuffer.y--,this._bufferService.scroll(this._eraseAttrData())):this._activeBuffer.y>=this._bufferService.rows&&(this._activeBuffer.y=this._bufferService.rows-1),this._activeBuffer.x>=this._bufferService.cols&&this._activeBuffer.x--,this._dirtyRowService.markDirty(this._activeBuffer.y),this._onLineFeed.fire(),!0},t.prototype.carriageReturn=function(){return this._activeBuffer.x=0,!0},t.prototype.backspace=function(){var e;if(!this._coreService.decPrivateModes.reverseWraparound)return this._restrictCursor(),this._activeBuffer.x>0&&this._activeBuffer.x--,!0;if(this._restrictCursor(this._bufferService.cols),this._activeBuffer.x>0)this._activeBuffer.x--;else if(0===this._activeBuffer.x&&this._activeBuffer.y>this._activeBuffer.scrollTop&&this._activeBuffer.y<=this._activeBuffer.scrollBottom&&(null===(e=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y))||void 0===e?void 0:e.isWrapped)){this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y).isWrapped=!1,this._activeBuffer.y--,this._activeBuffer.x=this._bufferService.cols-1;var t=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y);t.hasWidth(this._activeBuffer.x)&&!t.hasContent(this._activeBuffer.x)&&this._activeBuffer.x--;}return this._restrictCursor(),!0},t.prototype.tab=function(){if(this._activeBuffer.x>=this._bufferService.cols)return !0;var e=this._activeBuffer.x;return this._activeBuffer.x=this._activeBuffer.nextStop(),this._optionsService.rawOptions.screenReaderMode&&this._onA11yTab.fire(this._activeBuffer.x-e),!0},t.prototype.shiftOut=function(){return this._charsetService.setgLevel(1),!0},t.prototype.shiftIn=function(){return this._charsetService.setgLevel(0),!0},t.prototype._restrictCursor=function(e){void 0===e&&(e=this._bufferService.cols-1),this._activeBuffer.x=Math.min(e,Math.max(0,this._activeBuffer.x)),this._activeBuffer.y=this._coreService.decPrivateModes.origin?Math.min(this._activeBuffer.scrollBottom,Math.max(this._activeBuffer.scrollTop,this._activeBuffer.y)):Math.min(this._bufferService.rows-1,Math.max(0,this._activeBuffer.y)),this._dirtyRowService.markDirty(this._activeBuffer.y);},t.prototype._setCursor=function(e,t){this._dirtyRowService.markDirty(this._activeBuffer.y),this._coreService.decPrivateModes.origin?(this._activeBuffer.x=e,this._activeBuffer.y=this._activeBuffer.scrollTop+t):(this._activeBuffer.x=e,this._activeBuffer.y=t),this._restrictCursor(),this._dirtyRowService.markDirty(this._activeBuffer.y);},t.prototype._moveCursor=function(e,t){this._restrictCursor(),this._setCursor(this._activeBuffer.x+e,this._activeBuffer.y+t);},t.prototype.cursorUp=function(e){var t=this._activeBuffer.y-this._activeBuffer.scrollTop;return t>=0?this._moveCursor(0,-Math.min(t,e.params[0]||1)):this._moveCursor(0,-(e.params[0]||1)),!0},t.prototype.cursorDown=function(e){var t=this._activeBuffer.scrollBottom-this._activeBuffer.y;return t>=0?this._moveCursor(0,Math.min(t,e.params[0]||1)):this._moveCursor(0,e.params[0]||1),!0},t.prototype.cursorForward=function(e){return this._moveCursor(e.params[0]||1,0),!0},t.prototype.cursorBackward=function(e){return this._moveCursor(-(e.params[0]||1),0),!0},t.prototype.cursorNextLine=function(e){return this.cursorDown(e),this._activeBuffer.x=0,!0},t.prototype.cursorPrecedingLine=function(e){return this.cursorUp(e),this._activeBuffer.x=0,!0},t.prototype.cursorCharAbsolute=function(e){return this._setCursor((e.params[0]||1)-1,this._activeBuffer.y),!0},t.prototype.cursorPosition=function(e){return this._setCursor(e.length>=2?(e.params[1]||1)-1:0,(e.params[0]||1)-1),!0},t.prototype.charPosAbsolute=function(e){return this._setCursor((e.params[0]||1)-1,this._activeBuffer.y),!0},t.prototype.hPositionRelative=function(e){return this._moveCursor(e.params[0]||1,0),!0},t.prototype.linePosAbsolute=function(e){return this._setCursor(this._activeBuffer.x,(e.params[0]||1)-1),!0},t.prototype.vPositionRelative=function(e){return this._moveCursor(0,e.params[0]||1),!0},t.prototype.hVPosition=function(e){return this.cursorPosition(e),!0},t.prototype.tabClear=function(e){var t=e.params[0];return 0===t?delete this._activeBuffer.tabs[this._activeBuffer.x]:3===t&&(this._activeBuffer.tabs={}),!0},t.prototype.cursorForwardTab=function(e){if(this._activeBuffer.x>=this._bufferService.cols)return !0;for(var t=e.params[0]||1;t--;)this._activeBuffer.x=this._activeBuffer.nextStop();return !0},t.prototype.cursorBackwardTab=function(e){if(this._activeBuffer.x>=this._bufferService.cols)return !0;for(var t=e.params[0]||1;t--;)this._activeBuffer.x=this._activeBuffer.prevStop();return !0},t.prototype._eraseInBufferLine=function(e,t,r,i){void 0===i&&(i=!1);var n=this._activeBuffer.lines.get(this._activeBuffer.ybase+e);n.replaceCells(t,r,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),i&&(n.isWrapped=!1);},t.prototype._resetBufferLine=function(e){var t=this._activeBuffer.lines.get(this._activeBuffer.ybase+e);t.fill(this._activeBuffer.getNullCell(this._eraseAttrData())),this._bufferService.buffer.clearMarkers(this._activeBuffer.ybase+e),t.isWrapped=!1;},t.prototype.eraseInDisplay=function(e){var t;switch(this._restrictCursor(this._bufferService.cols),e.params[0]){case 0:for(t=this._activeBuffer.y,this._dirtyRowService.markDirty(t),this._eraseInBufferLine(t++,this._activeBuffer.x,this._bufferService.cols,0===this._activeBuffer.x);t<this._bufferService.rows;t++)this._resetBufferLine(t);this._dirtyRowService.markDirty(t);break;case 1:for(t=this._activeBuffer.y,this._dirtyRowService.markDirty(t),this._eraseInBufferLine(t,0,this._activeBuffer.x+1,!0),this._activeBuffer.x+1>=this._bufferService.cols&&(this._activeBuffer.lines.get(t+1).isWrapped=!1);t--;)this._resetBufferLine(t);this._dirtyRowService.markDirty(0);break;case 2:for(t=this._bufferService.rows,this._dirtyRowService.markDirty(t-1);t--;)this._resetBufferLine(t);this._dirtyRowService.markDirty(0);break;case 3:var r=this._activeBuffer.lines.length-this._bufferService.rows;r>0&&(this._activeBuffer.lines.trimStart(r),this._activeBuffer.ybase=Math.max(this._activeBuffer.ybase-r,0),this._activeBuffer.ydisp=Math.max(this._activeBuffer.ydisp-r,0),this._onScroll.fire(0));}return !0},t.prototype.eraseInLine=function(e){switch(this._restrictCursor(this._bufferService.cols),e.params[0]){case 0:this._eraseInBufferLine(this._activeBuffer.y,this._activeBuffer.x,this._bufferService.cols,0===this._activeBuffer.x);break;case 1:this._eraseInBufferLine(this._activeBuffer.y,0,this._activeBuffer.x+1,!1);break;case 2:this._eraseInBufferLine(this._activeBuffer.y,0,this._bufferService.cols,!0);}return this._dirtyRowService.markDirty(this._activeBuffer.y),!0},t.prototype.insertLines=function(e){this._restrictCursor();var t=e.params[0]||1;if(this._activeBuffer.y>this._activeBuffer.scrollBottom||this._activeBuffer.y<this._activeBuffer.scrollTop)return !0;for(var r=this._activeBuffer.ybase+this._activeBuffer.y,i=this._bufferService.rows-1-this._activeBuffer.scrollBottom,n=this._bufferService.rows-1+this._activeBuffer.ybase-i+1;t--;)this._activeBuffer.lines.splice(n-1,1),this._activeBuffer.lines.splice(r,0,this._activeBuffer.getBlankLine(this._eraseAttrData()));return this._dirtyRowService.markRangeDirty(this._activeBuffer.y,this._activeBuffer.scrollBottom),this._activeBuffer.x=0,!0},t.prototype.deleteLines=function(e){this._restrictCursor();var t=e.params[0]||1;if(this._activeBuffer.y>this._activeBuffer.scrollBottom||this._activeBuffer.y<this._activeBuffer.scrollTop)return !0;var r,i=this._activeBuffer.ybase+this._activeBuffer.y;for(r=this._bufferService.rows-1-this._activeBuffer.scrollBottom,r=this._bufferService.rows-1+this._activeBuffer.ybase-r;t--;)this._activeBuffer.lines.splice(i,1),this._activeBuffer.lines.splice(r,0,this._activeBuffer.getBlankLine(this._eraseAttrData()));return this._dirtyRowService.markRangeDirty(this._activeBuffer.y,this._activeBuffer.scrollBottom),this._activeBuffer.x=0,!0},t.prototype.insertChars=function(e){this._restrictCursor();var t=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y);return t&&(t.insertCells(this._activeBuffer.x,e.params[0]||1,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),this._dirtyRowService.markDirty(this._activeBuffer.y)),!0},t.prototype.deleteChars=function(e){this._restrictCursor();var t=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y);return t&&(t.deleteCells(this._activeBuffer.x,e.params[0]||1,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),this._dirtyRowService.markDirty(this._activeBuffer.y)),!0},t.prototype.scrollUp=function(e){for(var t=e.params[0]||1;t--;)this._activeBuffer.lines.splice(this._activeBuffer.ybase+this._activeBuffer.scrollTop,1),this._activeBuffer.lines.splice(this._activeBuffer.ybase+this._activeBuffer.scrollBottom,0,this._activeBuffer.getBlankLine(this._eraseAttrData()));return this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom),!0},t.prototype.scrollDown=function(e){for(var t=e.params[0]||1;t--;)this._activeBuffer.lines.splice(this._activeBuffer.ybase+this._activeBuffer.scrollBottom,1),this._activeBuffer.lines.splice(this._activeBuffer.ybase+this._activeBuffer.scrollTop,0,this._activeBuffer.getBlankLine(f.DEFAULT_ATTR_DATA));return this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom),!0},t.prototype.scrollLeft=function(e){if(this._activeBuffer.y>this._activeBuffer.scrollBottom||this._activeBuffer.y<this._activeBuffer.scrollTop)return !0;for(var t=e.params[0]||1,r=this._activeBuffer.scrollTop;r<=this._activeBuffer.scrollBottom;++r){var i=this._activeBuffer.lines.get(this._activeBuffer.ybase+r);i.deleteCells(0,t,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),i.isWrapped=!1;}return this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom),!0},t.prototype.scrollRight=function(e){if(this._activeBuffer.y>this._activeBuffer.scrollBottom||this._activeBuffer.y<this._activeBuffer.scrollTop)return !0;for(var t=e.params[0]||1,r=this._activeBuffer.scrollTop;r<=this._activeBuffer.scrollBottom;++r){var i=this._activeBuffer.lines.get(this._activeBuffer.ybase+r);i.insertCells(0,t,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),i.isWrapped=!1;}return this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom),!0},t.prototype.insertColumns=function(e){if(this._activeBuffer.y>this._activeBuffer.scrollBottom||this._activeBuffer.y<this._activeBuffer.scrollTop)return !0;for(var t=e.params[0]||1,r=this._activeBuffer.scrollTop;r<=this._activeBuffer.scrollBottom;++r){var i=this._activeBuffer.lines.get(this._activeBuffer.ybase+r);i.insertCells(this._activeBuffer.x,t,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),i.isWrapped=!1;}return this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom),!0},t.prototype.deleteColumns=function(e){if(this._activeBuffer.y>this._activeBuffer.scrollBottom||this._activeBuffer.y<this._activeBuffer.scrollTop)return !0;for(var t=e.params[0]||1,r=this._activeBuffer.scrollTop;r<=this._activeBuffer.scrollBottom;++r){var i=this._activeBuffer.lines.get(this._activeBuffer.ybase+r);i.deleteCells(this._activeBuffer.x,t,this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),i.isWrapped=!1;}return this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom),!0},t.prototype.eraseChars=function(e){this._restrictCursor();var t=this._activeBuffer.lines.get(this._activeBuffer.ybase+this._activeBuffer.y);return t&&(t.replaceCells(this._activeBuffer.x,this._activeBuffer.x+(e.params[0]||1),this._activeBuffer.getNullCell(this._eraseAttrData()),this._eraseAttrData()),this._dirtyRowService.markDirty(this._activeBuffer.y)),!0},t.prototype.repeatPrecedingCharacter=function(e){if(!this._parser.precedingCodepoint)return !0;for(var t=e.params[0]||1,r=new Uint32Array(t),i=0;i<t;++i)r[i]=this._parser.precedingCodepoint;return this.print(r,0,r.length),!0},t.prototype.sendDeviceAttributesPrimary=function(e){return e.params[0]>0||(this._is("xterm")||this._is("rxvt-unicode")||this._is("screen")?this._coreService.triggerDataEvent(s.C0.ESC+"[?1;2c"):this._is("linux")&&this._coreService.triggerDataEvent(s.C0.ESC+"[?6c")),!0},t.prototype.sendDeviceAttributesSecondary=function(e){return e.params[0]>0||(this._is("xterm")?this._coreService.triggerDataEvent(s.C0.ESC+"[>0;276;0c"):this._is("rxvt-unicode")?this._coreService.triggerDataEvent(s.C0.ESC+"[>85;95;0c"):this._is("linux")?this._coreService.triggerDataEvent(e.params[0]+"c"):this._is("screen")&&this._coreService.triggerDataEvent(s.C0.ESC+"[>83;40003;0c")),!0},t.prototype._is=function(e){return 0===(this._optionsService.rawOptions.termName+"").indexOf(e)},t.prototype.setMode=function(e){for(var t=0;t<e.length;t++)4===e.params[t]&&(this._coreService.modes.insertMode=!0);return !0},t.prototype.setModePrivate=function(e){for(var t=0;t<e.length;t++)switch(e.params[t]){case 1:this._coreService.decPrivateModes.applicationCursorKeys=!0;break;case 2:this._charsetService.setgCharset(0,a.DEFAULT_CHARSET),this._charsetService.setgCharset(1,a.DEFAULT_CHARSET),this._charsetService.setgCharset(2,a.DEFAULT_CHARSET),this._charsetService.setgCharset(3,a.DEFAULT_CHARSET);break;case 3:this._optionsService.rawOptions.windowOptions.setWinLines&&(this._bufferService.resize(132,this._bufferService.rows),this._onRequestReset.fire());break;case 6:this._coreService.decPrivateModes.origin=!0,this._setCursor(0,0);break;case 7:this._coreService.decPrivateModes.wraparound=!0;break;case 12:break;case 45:this._coreService.decPrivateModes.reverseWraparound=!0;break;case 66:this._logService.debug("Serial port requested application keypad."),this._coreService.decPrivateModes.applicationKeypad=!0,this._onRequestSyncScrollBar.fire();break;case 9:this._coreMouseService.activeProtocol="X10";break;case 1e3:this._coreMouseService.activeProtocol="VT200";break;case 1002:this._coreMouseService.activeProtocol="DRAG";break;case 1003:this._coreMouseService.activeProtocol="ANY";break;case 1004:this._coreService.decPrivateModes.sendFocus=!0,this._onRequestSendFocus.fire();break;case 1005:this._logService.debug("DECSET 1005 not supported (see #2507)");break;case 1006:this._coreMouseService.activeEncoding="SGR";break;case 1015:this._logService.debug("DECSET 1015 not supported (see #2507)");break;case 25:this._coreService.isCursorHidden=!1;break;case 1048:this.saveCursor();break;case 1049:this.saveCursor();case 47:case 1047:this._bufferService.buffers.activateAltBuffer(this._eraseAttrData()),this._coreService.isCursorInitialized=!0,this._onRequestRefreshRows.fire(0,this._bufferService.rows-1),this._onRequestSyncScrollBar.fire();break;case 2004:this._coreService.decPrivateModes.bracketedPasteMode=!0;}return !0},t.prototype.resetMode=function(e){for(var t=0;t<e.length;t++)4===e.params[t]&&(this._coreService.modes.insertMode=!1);return !0},t.prototype.resetModePrivate=function(e){for(var t=0;t<e.length;t++)switch(e.params[t]){case 1:this._coreService.decPrivateModes.applicationCursorKeys=!1;break;case 3:this._optionsService.rawOptions.windowOptions.setWinLines&&(this._bufferService.resize(80,this._bufferService.rows),this._onRequestReset.fire());break;case 6:this._coreService.decPrivateModes.origin=!1,this._setCursor(0,0);break;case 7:this._coreService.decPrivateModes.wraparound=!1;break;case 12:break;case 45:this._coreService.decPrivateModes.reverseWraparound=!1;break;case 66:this._logService.debug("Switching back to normal keypad."),this._coreService.decPrivateModes.applicationKeypad=!1,this._onRequestSyncScrollBar.fire();break;case 9:case 1e3:case 1002:case 1003:this._coreMouseService.activeProtocol="NONE";break;case 1004:this._coreService.decPrivateModes.sendFocus=!1;break;case 1005:this._logService.debug("DECRST 1005 not supported (see #2507)");break;case 1006:this._coreMouseService.activeEncoding="DEFAULT";break;case 1015:this._logService.debug("DECRST 1015 not supported (see #2507)");break;case 25:this._coreService.isCursorHidden=!0;break;case 1048:this.restoreCursor();break;case 1049:case 47:case 1047:this._bufferService.buffers.activateNormalBuffer(),1049===e.params[t]&&this.restoreCursor(),this._coreService.isCursorInitialized=!0,this._onRequestRefreshRows.fire(0,this._bufferService.rows-1),this._onRequestSyncScrollBar.fire();break;case 2004:this._coreService.decPrivateModes.bracketedPasteMode=!1;}return !0},t.prototype._updateAttrColor=function(e,t,r,i,n){return 2===t?(e|=50331648,e&=-16777216,e|=v.AttributeData.fromColorRGB([r,i,n])):5===t&&(e&=-50331904,e|=33554432|255&r),e},t.prototype._extractColor=function(e,t,r){var i=[0,0,-1,0,0,0],n=0,o=0;do{if(i[o+n]=e.params[t+o],e.hasSubParams(t+o)){var s=e.getSubParams(t+o),a=0;do{5===i[1]&&(n=1),i[o+a+1+n]=s[a];}while(++a<s.length&&a+o+1+n<i.length);break}if(5===i[1]&&o+n>=2||2===i[1]&&o+n>=5)break;i[1]&&(n=1);}while(++o+t<e.length&&o+n<i.length);for(a=2;a<i.length;++a)-1===i[a]&&(i[a]=0);switch(i[0]){case 38:r.fg=this._updateAttrColor(r.fg,i[1],i[3],i[4],i[5]);break;case 48:r.bg=this._updateAttrColor(r.bg,i[1],i[3],i[4],i[5]);break;case 58:r.extended=r.extended.clone(),r.extended.underlineColor=this._updateAttrColor(r.extended.underlineColor,i[1],i[3],i[4],i[5]);}return o},t.prototype._processUnderline=function(e,t){t.extended=t.extended.clone(),(!~e||e>5)&&(e=1),t.extended.underlineStyle=e,t.fg|=268435456,0===e&&(t.fg&=-268435457),t.updateExtended();},t.prototype.charAttributes=function(e){if(1===e.length&&0===e.params[0])return this._curAttrData.fg=f.DEFAULT_ATTR_DATA.fg,this._curAttrData.bg=f.DEFAULT_ATTR_DATA.bg,!0;for(var t,r=e.length,i=this._curAttrData,n=0;n<r;n++)(t=e.params[n])>=30&&t<=37?(i.fg&=-50331904,i.fg|=16777216|t-30):t>=40&&t<=47?(i.bg&=-50331904,i.bg|=16777216|t-40):t>=90&&t<=97?(i.fg&=-50331904,i.fg|=16777224|t-90):t>=100&&t<=107?(i.bg&=-50331904,i.bg|=16777224|t-100):0===t?(i.fg=f.DEFAULT_ATTR_DATA.fg,i.bg=f.DEFAULT_ATTR_DATA.bg):1===t?i.fg|=134217728:3===t?i.bg|=67108864:4===t?(i.fg|=268435456,this._processUnderline(e.hasSubParams(n)?e.getSubParams(n)[0]:1,i)):5===t?i.fg|=536870912:7===t?i.fg|=67108864:8===t?i.fg|=1073741824:9===t?i.fg|=2147483648:2===t?i.bg|=134217728:21===t?this._processUnderline(2,i):22===t?(i.fg&=-134217729,i.bg&=-134217729):23===t?i.bg&=-67108865:24===t?i.fg&=-268435457:25===t?i.fg&=-536870913:27===t?i.fg&=-67108865:28===t?i.fg&=-1073741825:29===t?i.fg&=2147483647:39===t?(i.fg&=-67108864,i.fg|=16777215&f.DEFAULT_ATTR_DATA.fg):49===t?(i.bg&=-67108864,i.bg|=16777215&f.DEFAULT_ATTR_DATA.bg):38===t||48===t||58===t?n+=this._extractColor(e,n,i):59===t?(i.extended=i.extended.clone(),i.extended.underlineColor=-1,i.updateExtended()):100===t?(i.fg&=-67108864,i.fg|=16777215&f.DEFAULT_ATTR_DATA.fg,i.bg&=-67108864,i.bg|=16777215&f.DEFAULT_ATTR_DATA.bg):this._logService.debug("Unknown SGR attribute: %d.",t);return !0},t.prototype.deviceStatus=function(e){switch(e.params[0]){case 5:this._coreService.triggerDataEvent(s.C0.ESC+"[0n");break;case 6:var t=this._activeBuffer.y+1,r=this._activeBuffer.x+1;this._coreService.triggerDataEvent(s.C0.ESC+"["+t+";"+r+"R");}return !0},t.prototype.deviceStatusPrivate=function(e){if(6===e.params[0]){var t=this._activeBuffer.y+1,r=this._activeBuffer.x+1;this._coreService.triggerDataEvent(s.C0.ESC+"[?"+t+";"+r+"R");}return !0},t.prototype.softReset=function(e){return this._coreService.isCursorHidden=!1,this._onRequestSyncScrollBar.fire(),this._activeBuffer.scrollTop=0,this._activeBuffer.scrollBottom=this._bufferService.rows-1,this._curAttrData=f.DEFAULT_ATTR_DATA.clone(),this._coreService.reset(),this._charsetService.reset(),this._activeBuffer.savedX=0,this._activeBuffer.savedY=this._activeBuffer.ybase,this._activeBuffer.savedCurAttrData.fg=this._curAttrData.fg,this._activeBuffer.savedCurAttrData.bg=this._curAttrData.bg,this._activeBuffer.savedCharset=this._charsetService.charset,this._coreService.decPrivateModes.origin=!1,!0},t.prototype.setCursorStyle=function(e){var t=e.params[0]||1;switch(t){case 1:case 2:this._optionsService.options.cursorStyle="block";break;case 3:case 4:this._optionsService.options.cursorStyle="underline";break;case 5:case 6:this._optionsService.options.cursorStyle="bar";}var r=t%2==1;return this._optionsService.options.cursorBlink=r,!0},t.prototype.setScrollRegion=function(e){var t,r=e.params[0]||1;return (e.length<2||(t=e.params[1])>this._bufferService.rows||0===t)&&(t=this._bufferService.rows),t>r&&(this._activeBuffer.scrollTop=r-1,this._activeBuffer.scrollBottom=t-1,this._setCursor(0,0)),!0},t.prototype.windowOptions=function(e){if(!w(e.params[0],this._optionsService.rawOptions.windowOptions))return !0;var t=e.length>1?e.params[1]:0;switch(e.params[0]){case 14:2!==t&&this._onRequestWindowsOptionsReport.fire(o.GET_WIN_SIZE_PIXELS);break;case 16:this._onRequestWindowsOptionsReport.fire(o.GET_CELL_SIZE_PIXELS);break;case 18:this._bufferService&&this._coreService.triggerDataEvent(s.C0.ESC+"[8;"+this._bufferService.rows+";"+this._bufferService.cols+"t");break;case 22:0!==t&&2!==t||(this._windowTitleStack.push(this._windowTitle),this._windowTitleStack.length>10&&this._windowTitleStack.shift()),0!==t&&1!==t||(this._iconNameStack.push(this._iconName),this._iconNameStack.length>10&&this._iconNameStack.shift());break;case 23:0!==t&&2!==t||this._windowTitleStack.length&&this.setTitle(this._windowTitleStack.pop()),0!==t&&1!==t||this._iconNameStack.length&&this.setIconName(this._iconNameStack.pop());}return !0},t.prototype.saveCursor=function(e){return this._activeBuffer.savedX=this._activeBuffer.x,this._activeBuffer.savedY=this._activeBuffer.ybase+this._activeBuffer.y,this._activeBuffer.savedCurAttrData.fg=this._curAttrData.fg,this._activeBuffer.savedCurAttrData.bg=this._curAttrData.bg,this._activeBuffer.savedCharset=this._charsetService.charset,!0},t.prototype.restoreCursor=function(e){return this._activeBuffer.x=this._activeBuffer.savedX||0,this._activeBuffer.y=Math.max(this._activeBuffer.savedY-this._activeBuffer.ybase,0),this._curAttrData.fg=this._activeBuffer.savedCurAttrData.fg,this._curAttrData.bg=this._activeBuffer.savedCurAttrData.bg,this._charsetService.charset=this._savedCharset,this._activeBuffer.savedCharset&&(this._charsetService.charset=this._activeBuffer.savedCharset),this._restrictCursor(),!0},t.prototype.setTitle=function(e){return this._windowTitle=e,this._onTitleChange.fire(e),!0},t.prototype.setIconName=function(e){return this._iconName=e,!0},t.prototype.setOrReportIndexedColor=function(e){for(var t=[],r=e.split(";");r.length>1;){var i=r.shift(),n=r.shift();if(/^\d+$/.exec(i)){var o=parseInt(i);if(0<=o&&o<256)if("?"===n)t.push({type:0,index:o});else {var s=(0, b.parseColor)(n);s&&t.push({type:1,index:o,color:s});}}}return t.length&&this._onColor.fire(t),!0},t.prototype._setOrReportSpecialColor=function(e,t){for(var r=e.split(";"),i=0;i<r.length&&!(t>=this._specialColors.length);++i,++t)if("?"===r[i])this._onColor.fire([{type:0,index:this._specialColors[t]}]);else {var n=(0, b.parseColor)(r[i]);n&&this._onColor.fire([{type:1,index:this._specialColors[t],color:n}]);}return !0},t.prototype.setOrReportFgColor=function(e){return this._setOrReportSpecialColor(e,0)},t.prototype.setOrReportBgColor=function(e){return this._setOrReportSpecialColor(e,1)},t.prototype.setOrReportCursorColor=function(e){return this._setOrReportSpecialColor(e,2)},t.prototype.restoreIndexedColor=function(e){if(!e)return this._onColor.fire([{type:2}]),!0;for(var t=[],r=e.split(";"),i=0;i<r.length;++i)if(/^\d+$/.exec(r[i])){var n=parseInt(r[i]);0<=n&&n<256&&t.push({type:2,index:n});}return t.length&&this._onColor.fire(t),!0},t.prototype.restoreFgColor=function(e){return this._onColor.fire([{type:2,index:256}]),!0},t.prototype.restoreBgColor=function(e){return this._onColor.fire([{type:2,index:257}]),!0},t.prototype.restoreCursorColor=function(e){return this._onColor.fire([{type:2,index:258}]),!0},t.prototype.nextLine=function(){return this._activeBuffer.x=0,this.index(),!0},t.prototype.keypadApplicationMode=function(){return this._logService.debug("Serial port requested application keypad."),this._coreService.decPrivateModes.applicationKeypad=!0,this._onRequestSyncScrollBar.fire(),!0},t.prototype.keypadNumericMode=function(){return this._logService.debug("Switching back to normal keypad."),this._coreService.decPrivateModes.applicationKeypad=!1,this._onRequestSyncScrollBar.fire(),!0},t.prototype.selectDefaultCharset=function(){return this._charsetService.setgLevel(0),this._charsetService.setgCharset(0,a.DEFAULT_CHARSET),!0},t.prototype.selectCharset=function(e){return 2!==e.length?(this.selectDefaultCharset(),!0):("/"===e[0]||this._charsetService.setgCharset(S[e[0]],a.CHARSETS[e[1]]||a.DEFAULT_CHARSET),!0)},t.prototype.index=function(){return this._restrictCursor(),this._activeBuffer.y++,this._activeBuffer.y===this._activeBuffer.scrollBottom+1?(this._activeBuffer.y--,this._bufferService.scroll(this._eraseAttrData())):this._activeBuffer.y>=this._bufferService.rows&&(this._activeBuffer.y=this._bufferService.rows-1),this._restrictCursor(),!0},t.prototype.tabSet=function(){return this._activeBuffer.tabs[this._activeBuffer.x]=!0,!0},t.prototype.reverseIndex=function(){if(this._restrictCursor(),this._activeBuffer.y===this._activeBuffer.scrollTop){var e=this._activeBuffer.scrollBottom-this._activeBuffer.scrollTop;this._activeBuffer.lines.shiftElements(this._activeBuffer.ybase+this._activeBuffer.y,e,1),this._activeBuffer.lines.set(this._activeBuffer.ybase+this._activeBuffer.y,this._activeBuffer.getBlankLine(this._eraseAttrData())),this._dirtyRowService.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom);}else this._activeBuffer.y--,this._restrictCursor();return !0},t.prototype.fullReset=function(){return this._parser.reset(),this._onRequestReset.fire(),!0},t.prototype.reset=function(){this._curAttrData=f.DEFAULT_ATTR_DATA.clone(),this._eraseAttrDataInternal=f.DEFAULT_ATTR_DATA.clone();},t.prototype._eraseAttrData=function(){return this._eraseAttrDataInternal.bg&=-67108864,this._eraseAttrDataInternal.bg|=67108863&this._curAttrData.bg,this._eraseAttrDataInternal},t.prototype.setgLevel=function(e){return this._charsetService.setgLevel(e),!0},t.prototype.screenAlignmentPattern=function(){var e=new p.CellData;e.content=1<<22|"E".charCodeAt(0),e.fg=this._curAttrData.fg,e.bg=this._curAttrData.bg,this._setCursor(0,0);for(var t=0;t<this._bufferService.rows;++t){var r=this._activeBuffer.ybase+this._activeBuffer.y+t,i=this._activeBuffer.lines.get(r);i&&(i.fill(e),i.isWrapped=!1);}return this._dirtyRowService.markAllDirty(),this._setCursor(0,0),!0},t}(l.Disposable);t.InputHandler=E;},844:function(e,t){var r=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.getDisposeArrayDisposable=t.disposeArray=t.Disposable=void 0;var i=function(){function e(){this._disposables=[],this._isDisposed=!1;}return e.prototype.dispose=function(){var e,t;this._isDisposed=!0;try{for(var i=r(this._disposables),n=i.next();!n.done;n=i.next())n.value.dispose();}catch(t){e={error:t};}finally{try{n&&!n.done&&(t=i.return)&&t.call(i);}finally{if(e)throw e.error}}this._disposables.length=0;},e.prototype.register=function(e){return this._disposables.push(e),e},e.prototype.unregister=function(e){var t=this._disposables.indexOf(e);-1!==t&&this._disposables.splice(t,1);},e}();function n(e){var t,i;try{for(var n=r(e),o=n.next();!o.done;o=n.next())o.value.dispose();}catch(e){t={error:e};}finally{try{o&&!o.done&&(i=n.return)&&i.call(n);}finally{if(t)throw t.error}}e.length=0;}t.Disposable=i,t.disposeArray=n,t.getDisposeArrayDisposable=function(e){return {dispose:function(){return n(e)}}};},6114:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.isLinux=t.isWindows=t.isIphone=t.isIpad=t.isMac=t.isSafari=t.isLegacyEdge=t.isFirefox=void 0;var r="undefined"==typeof navigator,i=r?"node":navigator.userAgent,n=r?"node":navigator.platform;t.isFirefox=i.includes("Firefox"),t.isLegacyEdge=i.includes("Edge"),t.isSafari=/^((?!chrome|android).)*safari/i.test(i),t.isMac=["Macintosh","MacIntel","MacPPC","Mac68K"].includes(n),t.isIpad="iPad"===n,t.isIphone="iPhone"===n,t.isWindows=["Windows","Win16","Win32","WinCE"].includes(n),t.isLinux=n.indexOf("Linux")>=0;},6106:function(e,t){var r=this&&this.__generator||function(e,t){var r,i,n,o,s={label:0,sent:function(){if(1&n[0])throw n[1];return n[1]},trys:[],ops:[]};return o={next:a(0),throw:a(1),return:a(2)},"function"==typeof Symbol&&(o[Symbol.iterator]=function(){return this}),o;function a(o){return function(a){return function(o){if(r)throw new TypeError("Generator is already executing.");for(;s;)try{if(r=1,i&&(n=2&o[0]?i.return:o[0]?i.throw||((n=i.return)&&n.call(i),0):i.next)&&!(n=n.call(i,o[1])).done)return n;switch(i=0,n&&(o=[2&o[0],n.value]),o[0]){case 0:case 1:n=o;break;case 4:return s.label++,{value:o[1],done:!1};case 5:s.label++,i=o[1],o=[0];continue;case 7:o=s.ops.pop(),s.trys.pop();continue;default:if(!((n=(n=s.trys).length>0&&n[n.length-1])||6!==o[0]&&2!==o[0])){s=0;continue}if(3===o[0]&&(!n||o[1]>n[0]&&o[1]<n[3])){s.label=o[1];break}if(6===o[0]&&s.label<n[1]){s.label=n[1],n=o;break}if(n&&s.label<n[2]){s.label=n[2],s.ops.push(o);break}n[2]&&s.ops.pop(),s.trys.pop();continue}o=t.call(e,s);}catch(e){o=[6,e],i=0;}finally{r=n=0;}if(5&o[0])throw o[1];return {value:o[0]?o[1]:void 0,done:!0}}([o,a])}}};Object.defineProperty(t,"__esModule",{value:!0}),t.SortedList=void 0;var i=function(){function e(e){this._getKey=e,this._array=[];}return e.prototype.clear=function(){this._array.length=0;},e.prototype.insert=function(e){if(0!==this._array.length){var t=this._search(this._getKey(e),0,this._array.length-1);this._array.splice(t,0,e);}else this._array.push(e);},e.prototype.delete=function(e){if(0===this._array.length)return !1;var t=this._getKey(e),r=this._search(t,0,this._array.length-1);if(this._getKey(this._array[r])!==t)return !1;do{if(this._array[r]===e)return this._array.splice(r,1),!0}while(++r<this._array.length&&this._getKey(this._array[r])===t);return !1},e.prototype.getKeyIterator=function(e){var t;return r(this,(function(r){switch(r.label){case 0:if(0===this._array.length)return [2];if((t=this._search(e,0,this._array.length-1))<0||t>=this._array.length)return [2];if(this._getKey(this._array[t])!==e)return [2];r.label=1;case 1:return [4,this._array[t]];case 2:r.sent(),r.label=3;case 3:if(++t<this._array.length&&this._getKey(this._array[t])===e)return [3,1];r.label=4;case 4:return [2]}}))},e.prototype.values=function(){return this._array.values()},e.prototype._search=function(e,t,r){if(r<t)return t;var i=Math.floor((t+r)/2);if(this._getKey(this._array[i])>e)return this._search(e,t,i-1);if(this._getKey(this._array[i])<e)return this._search(e,i+1,r);for(;i>0&&this._getKey(this._array[i-1])===e;)i--;return i},e}();t.SortedList=i;},8273:(e,t)=>{function r(e,t,r,i){if(void 0===r&&(r=0),void 0===i&&(i=e.length),r>=e.length)return e;r=(e.length+r)%e.length,i=i>=e.length?e.length:(e.length+i)%e.length;for(var n=r;n<i;++n)e[n]=t;return e}Object.defineProperty(t,"__esModule",{value:!0}),t.concat=t.fillFallback=t.fill=void 0,t.fill=function(e,t,i,n){return e.fill?e.fill(t,i,n):r(e,t,i,n)},t.fillFallback=r,t.concat=function(e,t){var r=new e.constructor(e.length+t.length);return r.set(e),r.set(t,e.length),r};},9282:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.updateWindowsModeWrappedState=void 0;var i=r(643);t.updateWindowsModeWrappedState=function(e){var t=e.buffer.lines.get(e.buffer.ybase+e.buffer.y-1),r=null==t?void 0:t.get(e.cols-1),n=e.buffer.lines.get(e.buffer.ybase+e.buffer.y);n&&r&&(n.isWrapped=r[i.CHAR_DATA_CODE_INDEX]!==i.NULL_CELL_CODE&&r[i.CHAR_DATA_CODE_INDEX]!==i.WHITESPACE_CELL_CODE);};},3734:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.ExtendedAttrs=t.AttributeData=void 0;var r=function(){function e(){this.fg=0,this.bg=0,this.extended=new i;}return e.toColorRGB=function(e){return [e>>>16&255,e>>>8&255,255&e]},e.fromColorRGB=function(e){return (255&e[0])<<16|(255&e[1])<<8|255&e[2]},e.prototype.clone=function(){var t=new e;return t.fg=this.fg,t.bg=this.bg,t.extended=this.extended.clone(),t},e.prototype.isInverse=function(){return 67108864&this.fg},e.prototype.isBold=function(){return 134217728&this.fg},e.prototype.isUnderline=function(){return 268435456&this.fg},e.prototype.isBlink=function(){return 536870912&this.fg},e.prototype.isInvisible=function(){return 1073741824&this.fg},e.prototype.isItalic=function(){return 67108864&this.bg},e.prototype.isDim=function(){return 134217728&this.bg},e.prototype.isStrikethrough=function(){return 2147483648&this.fg},e.prototype.getFgColorMode=function(){return 50331648&this.fg},e.prototype.getBgColorMode=function(){return 50331648&this.bg},e.prototype.isFgRGB=function(){return 50331648==(50331648&this.fg)},e.prototype.isBgRGB=function(){return 50331648==(50331648&this.bg)},e.prototype.isFgPalette=function(){return 16777216==(50331648&this.fg)||33554432==(50331648&this.fg)},e.prototype.isBgPalette=function(){return 16777216==(50331648&this.bg)||33554432==(50331648&this.bg)},e.prototype.isFgDefault=function(){return 0==(50331648&this.fg)},e.prototype.isBgDefault=function(){return 0==(50331648&this.bg)},e.prototype.isAttributeDefault=function(){return 0===this.fg&&0===this.bg},e.prototype.getFgColor=function(){switch(50331648&this.fg){case 16777216:case 33554432:return 255&this.fg;case 50331648:return 16777215&this.fg;default:return -1}},e.prototype.getBgColor=function(){switch(50331648&this.bg){case 16777216:case 33554432:return 255&this.bg;case 50331648:return 16777215&this.bg;default:return -1}},e.prototype.hasExtendedAttrs=function(){return 268435456&this.bg},e.prototype.updateExtended=function(){this.extended.isEmpty()?this.bg&=-268435457:this.bg|=268435456;},e.prototype.getUnderlineColor=function(){if(268435456&this.bg&&~this.extended.underlineColor)switch(50331648&this.extended.underlineColor){case 16777216:case 33554432:return 255&this.extended.underlineColor;case 50331648:return 16777215&this.extended.underlineColor;default:return this.getFgColor()}return this.getFgColor()},e.prototype.getUnderlineColorMode=function(){return 268435456&this.bg&&~this.extended.underlineColor?50331648&this.extended.underlineColor:this.getFgColorMode()},e.prototype.isUnderlineColorRGB=function(){return 268435456&this.bg&&~this.extended.underlineColor?50331648==(50331648&this.extended.underlineColor):this.isFgRGB()},e.prototype.isUnderlineColorPalette=function(){return 268435456&this.bg&&~this.extended.underlineColor?16777216==(50331648&this.extended.underlineColor)||33554432==(50331648&this.extended.underlineColor):this.isFgPalette()},e.prototype.isUnderlineColorDefault=function(){return 268435456&this.bg&&~this.extended.underlineColor?0==(50331648&this.extended.underlineColor):this.isFgDefault()},e.prototype.getUnderlineStyle=function(){return 268435456&this.fg?268435456&this.bg?this.extended.underlineStyle:1:0},e}();t.AttributeData=r;var i=function(){function e(e,t){void 0===e&&(e=0),void 0===t&&(t=-1),this.underlineStyle=e,this.underlineColor=t;}return e.prototype.clone=function(){return new e(this.underlineStyle,this.underlineColor)},e.prototype.isEmpty=function(){return 0===this.underlineStyle},e}();t.ExtendedAttrs=i;},9092:function(e,t,r){var i=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s},n=this&&this.__spreadArray||function(e,t,r){if(r||2===arguments.length)for(var i,n=0,o=t.length;n<o;n++)!i&&n in t||(i||(i=Array.prototype.slice.call(t,0,n)),i[n]=t[n]);return e.concat(i||Array.prototype.slice.call(t))};Object.defineProperty(t,"__esModule",{value:!0}),t.BufferStringIterator=t.Buffer=t.MAX_BUFFER_SIZE=void 0;var o=r(6349),s=r(8437),a=r(511),c=r(643),l=r(4634),h=r(4863),u=r(7116),f=r(3734);t.MAX_BUFFER_SIZE=4294967295;var _=function(){function e(e,t,r){this._hasScrollback=e,this._optionsService=t,this._bufferService=r,this.ydisp=0,this.ybase=0,this.y=0,this.x=0,this.savedY=0,this.savedX=0,this.savedCurAttrData=s.DEFAULT_ATTR_DATA.clone(),this.savedCharset=u.DEFAULT_CHARSET,this.markers=[],this._nullCell=a.CellData.fromCharData([0,c.NULL_CELL_CHAR,c.NULL_CELL_WIDTH,c.NULL_CELL_CODE]),this._whitespaceCell=a.CellData.fromCharData([0,c.WHITESPACE_CELL_CHAR,c.WHITESPACE_CELL_WIDTH,c.WHITESPACE_CELL_CODE]),this._isClearing=!1,this._cols=this._bufferService.cols,this._rows=this._bufferService.rows,this.lines=new o.CircularList(this._getCorrectBufferLength(this._rows)),this.scrollTop=0,this.scrollBottom=this._rows-1,this.setupTabStops();}return e.prototype.getNullCell=function(e){return e?(this._nullCell.fg=e.fg,this._nullCell.bg=e.bg,this._nullCell.extended=e.extended):(this._nullCell.fg=0,this._nullCell.bg=0,this._nullCell.extended=new f.ExtendedAttrs),this._nullCell},e.prototype.getWhitespaceCell=function(e){return e?(this._whitespaceCell.fg=e.fg,this._whitespaceCell.bg=e.bg,this._whitespaceCell.extended=e.extended):(this._whitespaceCell.fg=0,this._whitespaceCell.bg=0,this._whitespaceCell.extended=new f.ExtendedAttrs),this._whitespaceCell},e.prototype.getBlankLine=function(e,t){return new s.BufferLine(this._bufferService.cols,this.getNullCell(e),t)},Object.defineProperty(e.prototype,"hasScrollback",{get:function(){return this._hasScrollback&&this.lines.maxLength>this._rows},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"isCursorInViewport",{get:function(){var e=this.ybase+this.y-this.ydisp;return e>=0&&e<this._rows},enumerable:!1,configurable:!0}),e.prototype._getCorrectBufferLength=function(e){if(!this._hasScrollback)return e;var r=e+this._optionsService.rawOptions.scrollback;return r>t.MAX_BUFFER_SIZE?t.MAX_BUFFER_SIZE:r},e.prototype.fillViewportRows=function(e){if(0===this.lines.length){void 0===e&&(e=s.DEFAULT_ATTR_DATA);for(var t=this._rows;t--;)this.lines.push(this.getBlankLine(e));}},e.prototype.clear=function(){this.ydisp=0,this.ybase=0,this.y=0,this.x=0,this.lines=new o.CircularList(this._getCorrectBufferLength(this._rows)),this.scrollTop=0,this.scrollBottom=this._rows-1,this.setupTabStops();},e.prototype.resize=function(e,t){var r=this.getNullCell(s.DEFAULT_ATTR_DATA),i=this._getCorrectBufferLength(t);if(i>this.lines.maxLength&&(this.lines.maxLength=i),this.lines.length>0){if(this._cols<e)for(var n=0;n<this.lines.length;n++)this.lines.get(n).resize(e,r);var o=0;if(this._rows<t)for(var a=this._rows;a<t;a++)this.lines.length<t+this.ybase&&(this._optionsService.rawOptions.windowsMode?this.lines.push(new s.BufferLine(e,r)):this.ybase>0&&this.lines.length<=this.ybase+this.y+o+1?(this.ybase--,o++,this.ydisp>0&&this.ydisp--):this.lines.push(new s.BufferLine(e,r)));else for(a=this._rows;a>t;a--)this.lines.length>t+this.ybase&&(this.lines.length>this.ybase+this.y+1?this.lines.pop():(this.ybase++,this.ydisp++));if(i<this.lines.maxLength){var c=this.lines.length-i;c>0&&(this.lines.trimStart(c),this.ybase=Math.max(this.ybase-c,0),this.ydisp=Math.max(this.ydisp-c,0),this.savedY=Math.max(this.savedY-c,0)),this.lines.maxLength=i;}this.x=Math.min(this.x,e-1),this.y=Math.min(this.y,t-1),o&&(this.y+=o),this.savedX=Math.min(this.savedX,e-1),this.scrollTop=0;}if(this.scrollBottom=t-1,this._isReflowEnabled&&(this._reflow(e,t),this._cols>e))for(n=0;n<this.lines.length;n++)this.lines.get(n).resize(e,r);this._cols=e,this._rows=t;},Object.defineProperty(e.prototype,"_isReflowEnabled",{get:function(){return this._hasScrollback&&!this._optionsService.rawOptions.windowsMode},enumerable:!1,configurable:!0}),e.prototype._reflow=function(e,t){this._cols!==e&&(e>this._cols?this._reflowLarger(e,t):this._reflowSmaller(e,t));},e.prototype._reflowLarger=function(e,t){var r=(0, l.reflowLargerGetLinesToRemove)(this.lines,this._cols,e,this.ybase+this.y,this.getNullCell(s.DEFAULT_ATTR_DATA));if(r.length>0){var i=(0, l.reflowLargerCreateNewLayout)(this.lines,r);(0, l.reflowLargerApplyNewLayout)(this.lines,i.layout),this._reflowLargerAdjustViewport(e,t,i.countRemoved);}},e.prototype._reflowLargerAdjustViewport=function(e,t,r){for(var i=this.getNullCell(s.DEFAULT_ATTR_DATA),n=r;n-- >0;)0===this.ybase?(this.y>0&&this.y--,this.lines.length<t&&this.lines.push(new s.BufferLine(e,i))):(this.ydisp===this.ybase&&this.ydisp--,this.ybase--);this.savedY=Math.max(this.savedY-r,0);},e.prototype._reflowSmaller=function(e,t){for(var r=this.getNullCell(s.DEFAULT_ATTR_DATA),o=[],a=0,c=this.lines.length-1;c>=0;c--){var h=this.lines.get(c);if(!(!h||!h.isWrapped&&h.getTrimmedLength()<=e)){for(var u=[h];h.isWrapped&&c>0;)h=this.lines.get(--c),u.unshift(h);var f=this.ybase+this.y;if(!(f>=c&&f<c+u.length)){var _,d=u[u.length-1].getTrimmedLength(),p=(0, l.reflowSmallerGetNewLineLengths)(u,this._cols,e),v=p.length-u.length;_=0===this.ybase&&this.y!==this.lines.length-1?Math.max(0,this.y-this.lines.maxLength+v):Math.max(0,this.lines.length-this.lines.maxLength+v);for(var y=[],g=0;g<v;g++){var m=this.getBlankLine(s.DEFAULT_ATTR_DATA,!0);y.push(m);}y.length>0&&(o.push({start:c+u.length+a,newLines:y}),a+=y.length),u.push.apply(u,n([],i(y),!1));var b=p.length-1,S=p[b];0===S&&(S=p[--b]);for(var C=u.length-v-1,w=d;C>=0;){var L=Math.min(w,S);if(void 0===u[b])break;if(u[b].copyCellsFrom(u[C],w-L,S-L,L,!0),0==(S-=L)&&(S=p[--b]),0==(w-=L)){C--;var E=Math.max(C,0);w=(0, l.getWrappedLineTrimmedLength)(u,E,this._cols);}}for(g=0;g<u.length;g++)p[g]<e&&u[g].setCell(p[g],r);for(var x=v-_;x-- >0;)0===this.ybase?this.y<t-1?(this.y++,this.lines.pop()):(this.ybase++,this.ydisp++):this.ybase<Math.min(this.lines.maxLength,this.lines.length+a)-t&&(this.ybase===this.ydisp&&this.ydisp++,this.ybase++);this.savedY=Math.min(this.savedY+v,this.ybase+t-1);}}}if(o.length>0){var R=[],k=[];for(g=0;g<this.lines.length;g++)k.push(this.lines.get(g));var M=this.lines.length,A=M-1,O=0,D=o[O];this.lines.length=Math.min(this.lines.maxLength,this.lines.length+a);var T=0;for(g=Math.min(this.lines.maxLength-1,M+a-1);g>=0;g--)if(D&&D.start>A+T){for(var B=D.newLines.length-1;B>=0;B--)this.lines.set(g--,D.newLines[B]);g++,R.push({index:A+1,amount:D.newLines.length}),T+=D.newLines.length,D=o[++O];}else this.lines.set(g,k[A--]);var P=0;for(g=R.length-1;g>=0;g--)R[g].index+=P,this.lines.onInsertEmitter.fire(R[g]),P+=R[g].amount;var I=Math.max(0,M+a-this.lines.maxLength);I>0&&this.lines.onTrimEmitter.fire(I);}},e.prototype.stringIndexToBufferIndex=function(e,t,r){for(void 0===r&&(r=!1);t;){var i=this.lines.get(e);if(!i)return [-1,-1];for(var n=r?i.getTrimmedLength():i.length,o=0;o<n;++o)if(i.get(o)[c.CHAR_DATA_WIDTH_INDEX]&&(t-=i.get(o)[c.CHAR_DATA_CHAR_INDEX].length||1),t<0)return [e,o];e++;}return [e,0]},e.prototype.translateBufferLineToString=function(e,t,r,i){void 0===r&&(r=0);var n=this.lines.get(e);return n?n.translateToString(t,r,i):""},e.prototype.getWrappedRangeForLine=function(e){for(var t=e,r=e;t>0&&this.lines.get(t).isWrapped;)t--;for(;r+1<this.lines.length&&this.lines.get(r+1).isWrapped;)r++;return {first:t,last:r}},e.prototype.setupTabStops=function(e){for(null!=e?this.tabs[e]||(e=this.prevStop(e)):(this.tabs={},e=0);e<this._cols;e+=this._optionsService.rawOptions.tabStopWidth)this.tabs[e]=!0;},e.prototype.prevStop=function(e){for(null==e&&(e=this.x);!this.tabs[--e]&&e>0;);return e>=this._cols?this._cols-1:e<0?0:e},e.prototype.nextStop=function(e){for(null==e&&(e=this.x);!this.tabs[++e]&&e<this._cols;);return e>=this._cols?this._cols-1:e<0?0:e},e.prototype.clearMarkers=function(e){this._isClearing=!0;for(var t=0;t<this.markers.length;t++)this.markers[t].line===e&&(this.markers[t].dispose(),this.markers.splice(t--,1));this._isClearing=!1;},e.prototype.clearAllMarkers=function(){this._isClearing=!0;for(var e=0;e<this.markers.length;e++)this.markers[e].dispose(),this.markers.splice(e--,1);this._isClearing=!1;},e.prototype.addMarker=function(e){var t=this,r=new h.Marker(e);return this.markers.push(r),r.register(this.lines.onTrim((function(e){r.line-=e,r.line<0&&r.dispose();}))),r.register(this.lines.onInsert((function(e){r.line>=e.index&&(r.line+=e.amount);}))),r.register(this.lines.onDelete((function(e){r.line>=e.index&&r.line<e.index+e.amount&&r.dispose(),r.line>e.index&&(r.line-=e.amount);}))),r.register(r.onDispose((function(){return t._removeMarker(r)}))),r},e.prototype._removeMarker=function(e){this._isClearing||this.markers.splice(this.markers.indexOf(e),1);},e.prototype.iterator=function(e,t,r,i,n){return new d(this,e,t,r,i,n)},e}();t.Buffer=_;var d=function(){function e(e,t,r,i,n,o){void 0===r&&(r=0),void 0===i&&(i=e.lines.length),void 0===n&&(n=0),void 0===o&&(o=0),this._buffer=e,this._trimRight=t,this._startIndex=r,this._endIndex=i,this._startOverscan=n,this._endOverscan=o,this._startIndex<0&&(this._startIndex=0),this._endIndex>this._buffer.lines.length&&(this._endIndex=this._buffer.lines.length),this._current=this._startIndex;}return e.prototype.hasNext=function(){return this._current<this._endIndex},e.prototype.next=function(){var e=this._buffer.getWrappedRangeForLine(this._current);e.first<this._startIndex-this._startOverscan&&(e.first=this._startIndex-this._startOverscan),e.last>this._endIndex+this._endOverscan&&(e.last=this._endIndex+this._endOverscan),e.first=Math.max(e.first,0),e.last=Math.min(e.last,this._buffer.lines.length);for(var t="",r=e.first;r<=e.last;++r)t+=this._buffer.translateBufferLineToString(r,this._trimRight);return this._current=e.last+1,{range:e,content:t}},e}();t.BufferStringIterator=d;},8437:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.BufferLine=t.DEFAULT_ATTR_DATA=void 0;var i=r(482),n=r(643),o=r(511),s=r(3734);t.DEFAULT_ATTR_DATA=Object.freeze(new s.AttributeData);var a=function(){function e(e,t,r){void 0===r&&(r=!1),this.isWrapped=r,this._combined={},this._extendedAttrs={},this._data=new Uint32Array(3*e);for(var i=t||o.CellData.fromCharData([0,n.NULL_CELL_CHAR,n.NULL_CELL_WIDTH,n.NULL_CELL_CODE]),s=0;s<e;++s)this.setCell(s,i);this.length=e;}return e.prototype.get=function(e){var t=this._data[3*e+0],r=2097151&t;return [this._data[3*e+1],2097152&t?this._combined[e]:r?(0, i.stringFromCodePoint)(r):"",t>>22,2097152&t?this._combined[e].charCodeAt(this._combined[e].length-1):r]},e.prototype.set=function(e,t){this._data[3*e+1]=t[n.CHAR_DATA_ATTR_INDEX],t[n.CHAR_DATA_CHAR_INDEX].length>1?(this._combined[e]=t[1],this._data[3*e+0]=2097152|e|t[n.CHAR_DATA_WIDTH_INDEX]<<22):this._data[3*e+0]=t[n.CHAR_DATA_CHAR_INDEX].charCodeAt(0)|t[n.CHAR_DATA_WIDTH_INDEX]<<22;},e.prototype.getWidth=function(e){return this._data[3*e+0]>>22},e.prototype.hasWidth=function(e){return 12582912&this._data[3*e+0]},e.prototype.getFg=function(e){return this._data[3*e+1]},e.prototype.getBg=function(e){return this._data[3*e+2]},e.prototype.hasContent=function(e){return 4194303&this._data[3*e+0]},e.prototype.getCodePoint=function(e){var t=this._data[3*e+0];return 2097152&t?this._combined[e].charCodeAt(this._combined[e].length-1):2097151&t},e.prototype.isCombined=function(e){return 2097152&this._data[3*e+0]},e.prototype.getString=function(e){var t=this._data[3*e+0];return 2097152&t?this._combined[e]:2097151&t?(0, i.stringFromCodePoint)(2097151&t):""},e.prototype.loadCell=function(e,t){var r=3*e;return t.content=this._data[r+0],t.fg=this._data[r+1],t.bg=this._data[r+2],2097152&t.content&&(t.combinedData=this._combined[e]),268435456&t.bg&&(t.extended=this._extendedAttrs[e]),t},e.prototype.setCell=function(e,t){2097152&t.content&&(this._combined[e]=t.combinedData),268435456&t.bg&&(this._extendedAttrs[e]=t.extended),this._data[3*e+0]=t.content,this._data[3*e+1]=t.fg,this._data[3*e+2]=t.bg;},e.prototype.setCellFromCodePoint=function(e,t,r,i,n,o){268435456&n&&(this._extendedAttrs[e]=o),this._data[3*e+0]=t|r<<22,this._data[3*e+1]=i,this._data[3*e+2]=n;},e.prototype.addCodepointToCell=function(e,t){var r=this._data[3*e+0];2097152&r?this._combined[e]+=(0, i.stringFromCodePoint)(t):(2097151&r?(this._combined[e]=(0, i.stringFromCodePoint)(2097151&r)+(0, i.stringFromCodePoint)(t),r&=-2097152,r|=2097152):r=t|1<<22,this._data[3*e+0]=r);},e.prototype.insertCells=function(e,t,r,i){if((e%=this.length)&&2===this.getWidth(e-1)&&this.setCellFromCodePoint(e-1,0,1,(null==i?void 0:i.fg)||0,(null==i?void 0:i.bg)||0,(null==i?void 0:i.extended)||new s.ExtendedAttrs),t<this.length-e){for(var n=new o.CellData,a=this.length-e-t-1;a>=0;--a)this.setCell(e+t+a,this.loadCell(e+a,n));for(a=0;a<t;++a)this.setCell(e+a,r);}else for(a=e;a<this.length;++a)this.setCell(a,r);2===this.getWidth(this.length-1)&&this.setCellFromCodePoint(this.length-1,0,1,(null==i?void 0:i.fg)||0,(null==i?void 0:i.bg)||0,(null==i?void 0:i.extended)||new s.ExtendedAttrs);},e.prototype.deleteCells=function(e,t,r,i){if(e%=this.length,t<this.length-e){for(var n=new o.CellData,a=0;a<this.length-e-t;++a)this.setCell(e+a,this.loadCell(e+t+a,n));for(a=this.length-t;a<this.length;++a)this.setCell(a,r);}else for(a=e;a<this.length;++a)this.setCell(a,r);e&&2===this.getWidth(e-1)&&this.setCellFromCodePoint(e-1,0,1,(null==i?void 0:i.fg)||0,(null==i?void 0:i.bg)||0,(null==i?void 0:i.extended)||new s.ExtendedAttrs),0!==this.getWidth(e)||this.hasContent(e)||this.setCellFromCodePoint(e,0,1,(null==i?void 0:i.fg)||0,(null==i?void 0:i.bg)||0,(null==i?void 0:i.extended)||new s.ExtendedAttrs);},e.prototype.replaceCells=function(e,t,r,i){for(e&&2===this.getWidth(e-1)&&this.setCellFromCodePoint(e-1,0,1,(null==i?void 0:i.fg)||0,(null==i?void 0:i.bg)||0,(null==i?void 0:i.extended)||new s.ExtendedAttrs),t<this.length&&2===this.getWidth(t-1)&&this.setCellFromCodePoint(t,0,1,(null==i?void 0:i.fg)||0,(null==i?void 0:i.bg)||0,(null==i?void 0:i.extended)||new s.ExtendedAttrs);e<t&&e<this.length;)this.setCell(e++,r);},e.prototype.resize=function(e,t){if(e!==this.length){if(e>this.length){var r=new Uint32Array(3*e);this.length&&(3*e<this._data.length?r.set(this._data.subarray(0,3*e)):r.set(this._data)),this._data=r;for(var i=this.length;i<e;++i)this.setCell(i,t);}else if(e){(r=new Uint32Array(3*e)).set(this._data.subarray(0,3*e)),this._data=r;var n=Object.keys(this._combined);for(i=0;i<n.length;i++){var o=parseInt(n[i],10);o>=e&&delete this._combined[o];}}else this._data=new Uint32Array(0),this._combined={};this.length=e;}},e.prototype.fill=function(e){this._combined={},this._extendedAttrs={};for(var t=0;t<this.length;++t)this.setCell(t,e);},e.prototype.copyFrom=function(e){for(var t in this.length!==e.length?this._data=new Uint32Array(e._data):this._data.set(e._data),this.length=e.length,this._combined={},e._combined)this._combined[t]=e._combined[t];for(var t in this._extendedAttrs={},e._extendedAttrs)this._extendedAttrs[t]=e._extendedAttrs[t];this.isWrapped=e.isWrapped;},e.prototype.clone=function(){var t=new e(0);for(var r in t._data=new Uint32Array(this._data),t.length=this.length,this._combined)t._combined[r]=this._combined[r];for(var r in this._extendedAttrs)t._extendedAttrs[r]=this._extendedAttrs[r];return t.isWrapped=this.isWrapped,t},e.prototype.getTrimmedLength=function(){for(var e=this.length-1;e>=0;--e)if(4194303&this._data[3*e+0])return e+(this._data[3*e+0]>>22);return 0},e.prototype.copyCellsFrom=function(e,t,r,i,n){var o=e._data;if(n)for(var s=i-1;s>=0;s--)for(var a=0;a<3;a++)this._data[3*(r+s)+a]=o[3*(t+s)+a];else for(s=0;s<i;s++)for(a=0;a<3;a++)this._data[3*(r+s)+a]=o[3*(t+s)+a];var c=Object.keys(e._combined);for(a=0;a<c.length;a++){var l=parseInt(c[a],10);l>=t&&(this._combined[l-t+r]=e._combined[l]);}},e.prototype.translateToString=function(e,t,r){void 0===e&&(e=!1),void 0===t&&(t=0),void 0===r&&(r=this.length),e&&(r=Math.min(r,this.getTrimmedLength()));for(var o="";t<r;){var s=this._data[3*t+0],a=2097151&s;o+=2097152&s?this._combined[t]:a?(0, i.stringFromCodePoint)(a):n.WHITESPACE_CELL_CHAR,t+=s>>22||1;}return o},e}();t.BufferLine=a;},4841:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.getRangeLength=void 0,t.getRangeLength=function(e,t){if(e.start.y>e.end.y)throw new Error("Buffer range end ("+e.end.x+", "+e.end.y+") cannot be before start ("+e.start.x+", "+e.start.y+")");return t*(e.end.y-e.start.y)+(e.end.x-e.start.x+1)};},4634:(e,t)=>{function r(e,t,r){if(t===e.length-1)return e[t].getTrimmedLength();var i=!e[t].hasContent(r-1)&&1===e[t].getWidth(r-1),n=2===e[t+1].getWidth(0);return i&&n?r-1:r}Object.defineProperty(t,"__esModule",{value:!0}),t.getWrappedLineTrimmedLength=t.reflowSmallerGetNewLineLengths=t.reflowLargerApplyNewLayout=t.reflowLargerCreateNewLayout=t.reflowLargerGetLinesToRemove=void 0,t.reflowLargerGetLinesToRemove=function(e,t,i,n,o){for(var s=[],a=0;a<e.length-1;a++){var c=a,l=e.get(++c);if(l.isWrapped){for(var h=[e.get(a)];c<e.length&&l.isWrapped;)h.push(l),l=e.get(++c);if(n>=a&&n<c)a+=h.length-1;else {for(var u=0,f=r(h,u,t),_=1,d=0;_<h.length;){var p=r(h,_,t),v=p-d,y=i-f,g=Math.min(v,y);h[u].copyCellsFrom(h[_],d,f,g,!1),(f+=g)===i&&(u++,f=0),(d+=g)===p&&(_++,d=0),0===f&&0!==u&&2===h[u-1].getWidth(i-1)&&(h[u].copyCellsFrom(h[u-1],i-1,f++,1,!1),h[u-1].setCell(i-1,o));}h[u].replaceCells(f,i,o);for(var m=0,b=h.length-1;b>0&&(b>u||0===h[b].getTrimmedLength());b--)m++;m>0&&(s.push(a+h.length-m),s.push(m)),a+=h.length-1;}}}return s},t.reflowLargerCreateNewLayout=function(e,t){for(var r=[],i=0,n=t[i],o=0,s=0;s<e.length;s++)if(n===s){var a=t[++i];e.onDeleteEmitter.fire({index:s-o,amount:a}),s+=a-1,o+=a,n=t[++i];}else r.push(s);return {layout:r,countRemoved:o}},t.reflowLargerApplyNewLayout=function(e,t){for(var r=[],i=0;i<t.length;i++)r.push(e.get(t[i]));for(i=0;i<r.length;i++)e.set(i,r[i]);e.length=t.length;},t.reflowSmallerGetNewLineLengths=function(e,t,i){for(var n=[],o=e.map((function(i,n){return r(e,n,t)})).reduce((function(e,t){return e+t})),s=0,a=0,c=0;c<o;){if(o-c<i){n.push(o-c);break}s+=i;var l=r(e,a,t);s>l&&(s-=l,a++);var h=2===e[a].getWidth(s-1);h&&s--;var u=h?i-1:i;n.push(u),c+=u;}return n},t.getWrappedLineTrimmedLength=r;},5295:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.BufferSet=void 0;var o=r(9092),s=r(8460),a=function(e){function t(t,r){var i=e.call(this)||this;return i._optionsService=t,i._bufferService=r,i._onBufferActivate=i.register(new s.EventEmitter),i.reset(),i}return n(t,e),Object.defineProperty(t.prototype,"onBufferActivate",{get:function(){return this._onBufferActivate.event},enumerable:!1,configurable:!0}),t.prototype.reset=function(){this._normal=new o.Buffer(!0,this._optionsService,this._bufferService),this._normal.fillViewportRows(),this._alt=new o.Buffer(!1,this._optionsService,this._bufferService),this._activeBuffer=this._normal,this._onBufferActivate.fire({activeBuffer:this._normal,inactiveBuffer:this._alt}),this.setupTabStops();},Object.defineProperty(t.prototype,"alt",{get:function(){return this._alt},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"active",{get:function(){return this._activeBuffer},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"normal",{get:function(){return this._normal},enumerable:!1,configurable:!0}),t.prototype.activateNormalBuffer=function(){this._activeBuffer!==this._normal&&(this._normal.x=this._alt.x,this._normal.y=this._alt.y,this._alt.clear(),this._activeBuffer=this._normal,this._onBufferActivate.fire({activeBuffer:this._normal,inactiveBuffer:this._alt}));},t.prototype.activateAltBuffer=function(e){this._activeBuffer!==this._alt&&(this._alt.fillViewportRows(e),this._alt.x=this._normal.x,this._alt.y=this._normal.y,this._activeBuffer=this._alt,this._onBufferActivate.fire({activeBuffer:this._alt,inactiveBuffer:this._normal}));},t.prototype.resize=function(e,t){this._normal.resize(e,t),this._alt.resize(e,t);},t.prototype.setupTabStops=function(e){this._normal.setupTabStops(e),this._alt.setupTabStops(e);},t}(r(844).Disposable);t.BufferSet=a;},511:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.CellData=void 0;var o=r(482),s=r(643),a=r(3734),c=function(e){function t(){var t=null!==e&&e.apply(this,arguments)||this;return t.content=0,t.fg=0,t.bg=0,t.extended=new a.ExtendedAttrs,t.combinedData="",t}return n(t,e),t.fromCharData=function(e){var r=new t;return r.setFromCharData(e),r},t.prototype.isCombined=function(){return 2097152&this.content},t.prototype.getWidth=function(){return this.content>>22},t.prototype.getChars=function(){return 2097152&this.content?this.combinedData:2097151&this.content?(0, o.stringFromCodePoint)(2097151&this.content):""},t.prototype.getCode=function(){return this.isCombined()?this.combinedData.charCodeAt(this.combinedData.length-1):2097151&this.content},t.prototype.setFromCharData=function(e){this.fg=e[s.CHAR_DATA_ATTR_INDEX],this.bg=0;var t=!1;if(e[s.CHAR_DATA_CHAR_INDEX].length>2)t=!0;else if(2===e[s.CHAR_DATA_CHAR_INDEX].length){var r=e[s.CHAR_DATA_CHAR_INDEX].charCodeAt(0);if(55296<=r&&r<=56319){var i=e[s.CHAR_DATA_CHAR_INDEX].charCodeAt(1);56320<=i&&i<=57343?this.content=1024*(r-55296)+i-56320+65536|e[s.CHAR_DATA_WIDTH_INDEX]<<22:t=!0;}else t=!0;}else this.content=e[s.CHAR_DATA_CHAR_INDEX].charCodeAt(0)|e[s.CHAR_DATA_WIDTH_INDEX]<<22;t&&(this.combinedData=e[s.CHAR_DATA_CHAR_INDEX],this.content=2097152|e[s.CHAR_DATA_WIDTH_INDEX]<<22);},t.prototype.getAsCharData=function(){return [this.fg,this.getChars(),this.getWidth(),this.getCode()]},t}(a.AttributeData);t.CellData=c;},643:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.WHITESPACE_CELL_CODE=t.WHITESPACE_CELL_WIDTH=t.WHITESPACE_CELL_CHAR=t.NULL_CELL_CODE=t.NULL_CELL_WIDTH=t.NULL_CELL_CHAR=t.CHAR_DATA_CODE_INDEX=t.CHAR_DATA_WIDTH_INDEX=t.CHAR_DATA_CHAR_INDEX=t.CHAR_DATA_ATTR_INDEX=t.DEFAULT_ATTR=t.DEFAULT_COLOR=void 0,t.DEFAULT_COLOR=256,t.DEFAULT_ATTR=256|t.DEFAULT_COLOR<<9,t.CHAR_DATA_ATTR_INDEX=0,t.CHAR_DATA_CHAR_INDEX=1,t.CHAR_DATA_WIDTH_INDEX=2,t.CHAR_DATA_CODE_INDEX=3,t.NULL_CELL_CHAR="",t.NULL_CELL_WIDTH=1,t.NULL_CELL_CODE=0,t.WHITESPACE_CELL_CHAR=" ",t.WHITESPACE_CELL_WIDTH=1,t.WHITESPACE_CELL_CODE=32;},4863:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.Marker=void 0;var o=r(8460),s=function(e){function t(r){var i=e.call(this)||this;return i.line=r,i._id=t._nextId++,i.isDisposed=!1,i._onDispose=new o.EventEmitter,i}return n(t,e),Object.defineProperty(t.prototype,"id",{get:function(){return this._id},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onDispose",{get:function(){return this._onDispose.event},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){this.isDisposed||(this.isDisposed=!0,this.line=-1,this._onDispose.fire(),e.prototype.dispose.call(this));},t._nextId=1,t}(r(844).Disposable);t.Marker=s;},7116:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.DEFAULT_CHARSET=t.CHARSETS=void 0,t.CHARSETS={},t.DEFAULT_CHARSET=t.CHARSETS.B,t.CHARSETS[0]={"`":"◆",a:"▒",b:"␉",c:"␌",d:"␍",e:"␊",f:"°",g:"±",h:"␤",i:"␋",j:"┘",k:"┐",l:"┌",m:"└",n:"┼",o:"⎺",p:"⎻",q:"─",r:"⎼",s:"⎽",t:"├",u:"┤",v:"┴",w:"┬",x:"│",y:"≤",z:"≥","{":"π","|":"≠","}":"£","~":"·"},t.CHARSETS.A={"#":"£"},t.CHARSETS.B=void 0,t.CHARSETS[4]={"#":"£","@":"¾","[":"ij","\\":"½","]":"|","{":"¨","|":"f","}":"¼","~":"´"},t.CHARSETS.C=t.CHARSETS[5]={"[":"Ä","\\":"Ö","]":"Å","^":"Ü","`":"é","{":"ä","|":"ö","}":"å","~":"ü"},t.CHARSETS.R={"#":"£","@":"à","[":"°","\\":"ç","]":"§","{":"é","|":"ù","}":"è","~":"¨"},t.CHARSETS.Q={"@":"à","[":"â","\\":"ç","]":"ê","^":"î","`":"ô","{":"é","|":"ù","}":"è","~":"û"},t.CHARSETS.K={"@":"§","[":"Ä","\\":"Ö","]":"Ü","{":"ä","|":"ö","}":"ü","~":"ß"},t.CHARSETS.Y={"#":"£","@":"§","[":"°","\\":"ç","]":"é","`":"ù","{":"à","|":"ò","}":"è","~":"ì"},t.CHARSETS.E=t.CHARSETS[6]={"@":"Ä","[":"Æ","\\":"Ø","]":"Å","^":"Ü","`":"ä","{":"æ","|":"ø","}":"å","~":"ü"},t.CHARSETS.Z={"#":"£","@":"§","[":"¡","\\":"Ñ","]":"¿","{":"°","|":"ñ","}":"ç"},t.CHARSETS.H=t.CHARSETS[7]={"@":"É","[":"Ä","\\":"Ö","]":"Å","^":"Ü","`":"é","{":"ä","|":"ö","}":"å","~":"ü"},t.CHARSETS["="]={"#":"ù","@":"à","[":"é","\\":"ç","]":"ê","^":"î",_:"è","`":"ô","{":"ä","|":"ö","}":"ü","~":"û"};},2584:(e,t)=>{var r,i;Object.defineProperty(t,"__esModule",{value:!0}),t.C1_ESCAPED=t.C1=t.C0=void 0,function(e){e.NUL="\0",e.SOH="",e.STX="",e.ETX="",e.EOT="",e.ENQ="",e.ACK="",e.BEL="",e.BS="\b",e.HT="\t",e.LF="\n",e.VT="\v",e.FF="\f",e.CR="\r",e.SO="",e.SI="",e.DLE="",e.DC1="",e.DC2="",e.DC3="",e.DC4="",e.NAK="",e.SYN="",e.ETB="",e.CAN="",e.EM="",e.SUB="",e.ESC="",e.FS="",e.GS="",e.RS="",e.US="",e.SP=" ",e.DEL="";}(r=t.C0||(t.C0={})),(i=t.C1||(t.C1={})).PAD="",i.HOP="",i.BPH="",i.NBH="",i.IND="",i.NEL="",i.SSA="",i.ESA="",i.HTS="",i.HTJ="",i.VTS="",i.PLD="",i.PLU="",i.RI="",i.SS2="",i.SS3="",i.DCS="",i.PU1="",i.PU2="",i.STS="",i.CCH="",i.MW="",i.SPA="",i.EPA="",i.SOS="",i.SGCI="",i.SCI="",i.CSI="",i.ST="",i.OSC="",i.PM="",i.APC="",(t.C1_ESCAPED||(t.C1_ESCAPED={})).ST=r.ESC+"\\";},7399:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.evaluateKeyboardEvent=void 0;var i=r(2584),n={48:["0",")"],49:["1","!"],50:["2","@"],51:["3","#"],52:["4","$"],53:["5","%"],54:["6","^"],55:["7","&"],56:["8","*"],57:["9","("],186:[";",":"],187:["=","+"],188:[",","<"],189:["-","_"],190:[".",">"],191:["/","?"],192:["`","~"],219:["[","{"],220:["\\","|"],221:["]","}"],222:["'",'"']};t.evaluateKeyboardEvent=function(e,t,r,o){var s={type:0,cancel:!1,key:void 0},a=(e.shiftKey?1:0)|(e.altKey?2:0)|(e.ctrlKey?4:0)|(e.metaKey?8:0);switch(e.keyCode){case 0:"UIKeyInputUpArrow"===e.key?s.key=t?i.C0.ESC+"OA":i.C0.ESC+"[A":"UIKeyInputLeftArrow"===e.key?s.key=t?i.C0.ESC+"OD":i.C0.ESC+"[D":"UIKeyInputRightArrow"===e.key?s.key=t?i.C0.ESC+"OC":i.C0.ESC+"[C":"UIKeyInputDownArrow"===e.key&&(s.key=t?i.C0.ESC+"OB":i.C0.ESC+"[B");break;case 8:if(e.shiftKey){s.key=i.C0.BS;break}if(e.altKey){s.key=i.C0.ESC+i.C0.DEL;break}s.key=i.C0.DEL;break;case 9:if(e.shiftKey){s.key=i.C0.ESC+"[Z";break}s.key=i.C0.HT,s.cancel=!0;break;case 13:s.key=e.altKey?i.C0.ESC+i.C0.CR:i.C0.CR,s.cancel=!0;break;case 27:s.key=i.C0.ESC,e.altKey&&(s.key=i.C0.ESC+i.C0.ESC),s.cancel=!0;break;case 37:if(e.metaKey)break;a?(s.key=i.C0.ESC+"[1;"+(a+1)+"D",s.key===i.C0.ESC+"[1;3D"&&(s.key=i.C0.ESC+(r?"b":"[1;5D"))):s.key=t?i.C0.ESC+"OD":i.C0.ESC+"[D";break;case 39:if(e.metaKey)break;a?(s.key=i.C0.ESC+"[1;"+(a+1)+"C",s.key===i.C0.ESC+"[1;3C"&&(s.key=i.C0.ESC+(r?"f":"[1;5C"))):s.key=t?i.C0.ESC+"OC":i.C0.ESC+"[C";break;case 38:if(e.metaKey)break;a?(s.key=i.C0.ESC+"[1;"+(a+1)+"A",r||s.key!==i.C0.ESC+"[1;3A"||(s.key=i.C0.ESC+"[1;5A")):s.key=t?i.C0.ESC+"OA":i.C0.ESC+"[A";break;case 40:if(e.metaKey)break;a?(s.key=i.C0.ESC+"[1;"+(a+1)+"B",r||s.key!==i.C0.ESC+"[1;3B"||(s.key=i.C0.ESC+"[1;5B")):s.key=t?i.C0.ESC+"OB":i.C0.ESC+"[B";break;case 45:e.shiftKey||e.ctrlKey||(s.key=i.C0.ESC+"[2~");break;case 46:s.key=a?i.C0.ESC+"[3;"+(a+1)+"~":i.C0.ESC+"[3~";break;case 36:s.key=a?i.C0.ESC+"[1;"+(a+1)+"H":t?i.C0.ESC+"OH":i.C0.ESC+"[H";break;case 35:s.key=a?i.C0.ESC+"[1;"+(a+1)+"F":t?i.C0.ESC+"OF":i.C0.ESC+"[F";break;case 33:e.shiftKey?s.type=2:e.ctrlKey?s.key=i.C0.ESC+"[5;"+(a+1)+"~":s.key=i.C0.ESC+"[5~";break;case 34:e.shiftKey?s.type=3:e.ctrlKey?s.key=i.C0.ESC+"[6;"+(a+1)+"~":s.key=i.C0.ESC+"[6~";break;case 112:s.key=a?i.C0.ESC+"[1;"+(a+1)+"P":i.C0.ESC+"OP";break;case 113:s.key=a?i.C0.ESC+"[1;"+(a+1)+"Q":i.C0.ESC+"OQ";break;case 114:s.key=a?i.C0.ESC+"[1;"+(a+1)+"R":i.C0.ESC+"OR";break;case 115:s.key=a?i.C0.ESC+"[1;"+(a+1)+"S":i.C0.ESC+"OS";break;case 116:s.key=a?i.C0.ESC+"[15;"+(a+1)+"~":i.C0.ESC+"[15~";break;case 117:s.key=a?i.C0.ESC+"[17;"+(a+1)+"~":i.C0.ESC+"[17~";break;case 118:s.key=a?i.C0.ESC+"[18;"+(a+1)+"~":i.C0.ESC+"[18~";break;case 119:s.key=a?i.C0.ESC+"[19;"+(a+1)+"~":i.C0.ESC+"[19~";break;case 120:s.key=a?i.C0.ESC+"[20;"+(a+1)+"~":i.C0.ESC+"[20~";break;case 121:s.key=a?i.C0.ESC+"[21;"+(a+1)+"~":i.C0.ESC+"[21~";break;case 122:s.key=a?i.C0.ESC+"[23;"+(a+1)+"~":i.C0.ESC+"[23~";break;case 123:s.key=a?i.C0.ESC+"[24;"+(a+1)+"~":i.C0.ESC+"[24~";break;default:if(!e.ctrlKey||e.shiftKey||e.altKey||e.metaKey)if(r&&!o||!e.altKey||e.metaKey)!r||e.altKey||e.ctrlKey||e.shiftKey||!e.metaKey?e.key&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&e.keyCode>=48&&1===e.key.length?s.key=e.key:e.key&&e.ctrlKey&&("_"===e.key&&(s.key=i.C0.US),"@"===e.key&&(s.key=i.C0.NUL)):65===e.keyCode&&(s.type=1);else {var c=n[e.keyCode],l=null==c?void 0:c[e.shiftKey?1:0];if(l)s.key=i.C0.ESC+l;else if(e.keyCode>=65&&e.keyCode<=90){var h=e.ctrlKey?e.keyCode-64:e.keyCode+32,u=String.fromCharCode(h);e.shiftKey&&(u=u.toUpperCase()),s.key=i.C0.ESC+u;}else "Dead"===e.key&&e.code.startsWith("Key")&&(u=e.code.slice(3,4),e.shiftKey||(u=u.toLowerCase()),s.key=i.C0.ESC+u,s.cancel=!0);}else e.keyCode>=65&&e.keyCode<=90?s.key=String.fromCharCode(e.keyCode-64):32===e.keyCode?s.key=i.C0.NUL:e.keyCode>=51&&e.keyCode<=55?s.key=String.fromCharCode(e.keyCode-51+27):56===e.keyCode?s.key=i.C0.DEL:219===e.keyCode?s.key=i.C0.ESC:220===e.keyCode?s.key=i.C0.FS:221===e.keyCode&&(s.key=i.C0.GS);}return s};},482:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.Utf8ToUtf32=t.StringToUtf32=t.utf32ToString=t.stringFromCodePoint=void 0,t.stringFromCodePoint=function(e){return e>65535?(e-=65536,String.fromCharCode(55296+(e>>10))+String.fromCharCode(e%1024+56320)):String.fromCharCode(e)},t.utf32ToString=function(e,t,r){void 0===t&&(t=0),void 0===r&&(r=e.length);for(var i="",n=t;n<r;++n){var o=e[n];o>65535?(o-=65536,i+=String.fromCharCode(55296+(o>>10))+String.fromCharCode(o%1024+56320)):i+=String.fromCharCode(o);}return i};var r=function(){function e(){this._interim=0;}return e.prototype.clear=function(){this._interim=0;},e.prototype.decode=function(e,t){var r=e.length;if(!r)return 0;var i=0,n=0;this._interim&&(56320<=(a=e.charCodeAt(n++))&&a<=57343?t[i++]=1024*(this._interim-55296)+a-56320+65536:(t[i++]=this._interim,t[i++]=a),this._interim=0);for(var o=n;o<r;++o){var s=e.charCodeAt(o);if(55296<=s&&s<=56319){if(++o>=r)return this._interim=s,i;var a;56320<=(a=e.charCodeAt(o))&&a<=57343?t[i++]=1024*(s-55296)+a-56320+65536:(t[i++]=s,t[i++]=a);}else 65279!==s&&(t[i++]=s);}return i},e}();t.StringToUtf32=r;var i=function(){function e(){this.interim=new Uint8Array(3);}return e.prototype.clear=function(){this.interim.fill(0);},e.prototype.decode=function(e,t){var r=e.length;if(!r)return 0;var i,n,o,s,a=0,c=0,l=0;if(this.interim[0]){var h=!1,u=this.interim[0];u&=192==(224&u)?31:224==(240&u)?15:7;for(var f=0,_=void 0;(_=63&this.interim[++f])&&f<4;)u<<=6,u|=_;for(var d=192==(224&this.interim[0])?2:224==(240&this.interim[0])?3:4,p=d-f;l<p;){if(l>=r)return 0;if(128!=(192&(_=e[l++]))){l--,h=!0;break}this.interim[f++]=_,u<<=6,u|=63&_;}h||(2===d?u<128?l--:t[a++]=u:3===d?u<2048||u>=55296&&u<=57343||65279===u||(t[a++]=u):u<65536||u>1114111||(t[a++]=u)),this.interim.fill(0);}for(var v=r-4,y=l;y<r;){for(;!(!(y<v)||128&(i=e[y])||128&(n=e[y+1])||128&(o=e[y+2])||128&(s=e[y+3]));)t[a++]=i,t[a++]=n,t[a++]=o,t[a++]=s,y+=4;if((i=e[y++])<128)t[a++]=i;else if(192==(224&i)){if(y>=r)return this.interim[0]=i,a;if(128!=(192&(n=e[y++]))){y--;continue}if((c=(31&i)<<6|63&n)<128){y--;continue}t[a++]=c;}else if(224==(240&i)){if(y>=r)return this.interim[0]=i,a;if(128!=(192&(n=e[y++]))){y--;continue}if(y>=r)return this.interim[0]=i,this.interim[1]=n,a;if(128!=(192&(o=e[y++]))){y--;continue}if((c=(15&i)<<12|(63&n)<<6|63&o)<2048||c>=55296&&c<=57343||65279===c)continue;t[a++]=c;}else if(240==(248&i)){if(y>=r)return this.interim[0]=i,a;if(128!=(192&(n=e[y++]))){y--;continue}if(y>=r)return this.interim[0]=i,this.interim[1]=n,a;if(128!=(192&(o=e[y++]))){y--;continue}if(y>=r)return this.interim[0]=i,this.interim[1]=n,this.interim[2]=o,a;if(128!=(192&(s=e[y++]))){y--;continue}if((c=(7&i)<<18|(63&n)<<12|(63&o)<<6|63&s)<65536||c>1114111)continue;t[a++]=c;}}return a},e}();t.Utf8ToUtf32=i;},225:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.UnicodeV6=void 0;var i,n=r(8273),o=[[768,879],[1155,1158],[1160,1161],[1425,1469],[1471,1471],[1473,1474],[1476,1477],[1479,1479],[1536,1539],[1552,1557],[1611,1630],[1648,1648],[1750,1764],[1767,1768],[1770,1773],[1807,1807],[1809,1809],[1840,1866],[1958,1968],[2027,2035],[2305,2306],[2364,2364],[2369,2376],[2381,2381],[2385,2388],[2402,2403],[2433,2433],[2492,2492],[2497,2500],[2509,2509],[2530,2531],[2561,2562],[2620,2620],[2625,2626],[2631,2632],[2635,2637],[2672,2673],[2689,2690],[2748,2748],[2753,2757],[2759,2760],[2765,2765],[2786,2787],[2817,2817],[2876,2876],[2879,2879],[2881,2883],[2893,2893],[2902,2902],[2946,2946],[3008,3008],[3021,3021],[3134,3136],[3142,3144],[3146,3149],[3157,3158],[3260,3260],[3263,3263],[3270,3270],[3276,3277],[3298,3299],[3393,3395],[3405,3405],[3530,3530],[3538,3540],[3542,3542],[3633,3633],[3636,3642],[3655,3662],[3761,3761],[3764,3769],[3771,3772],[3784,3789],[3864,3865],[3893,3893],[3895,3895],[3897,3897],[3953,3966],[3968,3972],[3974,3975],[3984,3991],[3993,4028],[4038,4038],[4141,4144],[4146,4146],[4150,4151],[4153,4153],[4184,4185],[4448,4607],[4959,4959],[5906,5908],[5938,5940],[5970,5971],[6002,6003],[6068,6069],[6071,6077],[6086,6086],[6089,6099],[6109,6109],[6155,6157],[6313,6313],[6432,6434],[6439,6440],[6450,6450],[6457,6459],[6679,6680],[6912,6915],[6964,6964],[6966,6970],[6972,6972],[6978,6978],[7019,7027],[7616,7626],[7678,7679],[8203,8207],[8234,8238],[8288,8291],[8298,8303],[8400,8431],[12330,12335],[12441,12442],[43014,43014],[43019,43019],[43045,43046],[64286,64286],[65024,65039],[65056,65059],[65279,65279],[65529,65531]],s=[[68097,68099],[68101,68102],[68108,68111],[68152,68154],[68159,68159],[119143,119145],[119155,119170],[119173,119179],[119210,119213],[119362,119364],[917505,917505],[917536,917631],[917760,917999]],a=function(){function e(){if(this.version="6",!i){i=new Uint8Array(65536),(0, n.fill)(i,1),i[0]=0,(0, n.fill)(i,0,1,32),(0, n.fill)(i,0,127,160),(0, n.fill)(i,2,4352,4448),i[9001]=2,i[9002]=2,(0, n.fill)(i,2,11904,42192),i[12351]=1,(0, n.fill)(i,2,44032,55204),(0, n.fill)(i,2,63744,64256),(0, n.fill)(i,2,65040,65050),(0, n.fill)(i,2,65072,65136),(0, n.fill)(i,2,65280,65377),(0, n.fill)(i,2,65504,65511);for(var e=0;e<o.length;++e)(0, n.fill)(i,0,o[e][0],o[e][1]+1);}}return e.prototype.wcwidth=function(e){return e<32?0:e<127?1:e<65536?i[e]:function(e,t){var r,i=0,n=t.length-1;if(e<t[0][0]||e>t[n][1])return !1;for(;n>=i;)if(e>t[r=i+n>>1][1])i=r+1;else {if(!(e<t[r][0]))return !0;n=r-1;}return !1}(e,s)?0:e>=131072&&e<=196605||e>=196608&&e<=262141?2:1},e}();t.UnicodeV6=a;},5981:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.WriteBuffer=void 0;var i=r(8460),n="undefined"==typeof queueMicrotask?function(e){Promise.resolve().then(e);}:queueMicrotask,o=function(){function e(e){this._action=e,this._writeBuffer=[],this._callbacks=[],this._pendingData=0,this._bufferOffset=0,this._isSyncWriting=!1,this._syncCalls=0,this._onWriteParsed=new i.EventEmitter;}return Object.defineProperty(e.prototype,"onWriteParsed",{get:function(){return this._onWriteParsed.event},enumerable:!1,configurable:!0}),e.prototype.writeSync=function(e,t){if(void 0!==t&&this._syncCalls>t)this._syncCalls=0;else if(this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(void 0),this._syncCalls++,!this._isSyncWriting){var r;for(this._isSyncWriting=!0;r=this._writeBuffer.shift();){this._action(r);var i=this._callbacks.shift();i&&i();}this._pendingData=0,this._bufferOffset=2147483647,this._isSyncWriting=!1,this._syncCalls=0;}},e.prototype.write=function(e,t){var r=this;if(this._pendingData>5e7)throw new Error("write data discarded, use flow control to avoid losing data");this._writeBuffer.length||(this._bufferOffset=0,setTimeout((function(){return r._innerWrite()}))),this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t);},e.prototype._innerWrite=function(e,t){var r=this;void 0===e&&(e=0),void 0===t&&(t=!0);for(var i=e||Date.now();this._writeBuffer.length>this._bufferOffset;){var o=this._writeBuffer[this._bufferOffset],s=this._action(o,t);if(s)return void s.catch((function(e){return n((function(){throw e})),Promise.resolve(!1)})).then((function(e){return Date.now()-i>=12?setTimeout((function(){return r._innerWrite(0,e)})):r._innerWrite(i,e)}));var a=this._callbacks[this._bufferOffset];if(a&&a(),this._bufferOffset++,this._pendingData-=o.length,Date.now()-i>=12)break}this._writeBuffer.length>this._bufferOffset?(this._bufferOffset>50&&(this._writeBuffer=this._writeBuffer.slice(this._bufferOffset),this._callbacks=this._callbacks.slice(this._bufferOffset),this._bufferOffset=0),setTimeout((function(){return r._innerWrite()}))):(this._writeBuffer.length=0,this._callbacks.length=0,this._pendingData=0,this._bufferOffset=0),this._onWriteParsed.fire();},e}();t.WriteBuffer=o;},5941:function(e,t){var r=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s};Object.defineProperty(t,"__esModule",{value:!0}),t.toRgbString=t.parseColor=void 0;var i=/^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/,n=/^[\da-f]+$/;function o(e,t){var r=e.toString(16),i=r.length<2?"0"+r:r;switch(t){case 4:return r[0];case 8:return i;case 12:return (i+i).slice(0,3);default:return i+i}}t.parseColor=function(e){if(e){var t=e.toLowerCase();if(0===t.indexOf("rgb:")){t=t.slice(4);var r=i.exec(t);if(r){var o=r[1]?15:r[4]?255:r[7]?4095:65535;return [Math.round(parseInt(r[1]||r[4]||r[7]||r[10],16)/o*255),Math.round(parseInt(r[2]||r[5]||r[8]||r[11],16)/o*255),Math.round(parseInt(r[3]||r[6]||r[9]||r[12],16)/o*255)]}}else if(0===t.indexOf("#")&&(t=t.slice(1),n.exec(t)&&[3,6,9,12].includes(t.length))){for(var s=t.length/3,a=[0,0,0],c=0;c<3;++c){var l=parseInt(t.slice(s*c,s*c+s),16);a[c]=1===s?l<<4:2===s?l:3===s?l>>4:l>>8;}return a}}},t.toRgbString=function(e,t){void 0===t&&(t=16);var i=r(e,3),n=i[0],s=i[1],a=i[2];return "rgb:"+o(n,t)+"/"+o(s,t)+"/"+o(a,t)};},5770:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.PAYLOAD_LIMIT=void 0,t.PAYLOAD_LIMIT=1e7;},6351:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.DcsHandler=t.DcsParser=void 0;var i=r(482),n=r(8742),o=r(5770),s=[],a=function(){function e(){this._handlers=Object.create(null),this._active=s,this._ident=0,this._handlerFb=function(){},this._stack={paused:!1,loopPosition:0,fallThrough:!1};}return e.prototype.dispose=function(){this._handlers=Object.create(null),this._handlerFb=function(){},this._active=s;},e.prototype.registerHandler=function(e,t){void 0===this._handlers[e]&&(this._handlers[e]=[]);var r=this._handlers[e];return r.push(t),{dispose:function(){var e=r.indexOf(t);-1!==e&&r.splice(e,1);}}},e.prototype.clearHandler=function(e){this._handlers[e]&&delete this._handlers[e];},e.prototype.setHandlerFallback=function(e){this._handlerFb=e;},e.prototype.reset=function(){if(this._active.length)for(var e=this._stack.paused?this._stack.loopPosition-1:this._active.length-1;e>=0;--e)this._active[e].unhook(!1);this._stack.paused=!1,this._active=s,this._ident=0;},e.prototype.hook=function(e,t){if(this.reset(),this._ident=e,this._active=this._handlers[e]||s,this._active.length)for(var r=this._active.length-1;r>=0;r--)this._active[r].hook(t);else this._handlerFb(this._ident,"HOOK",t);},e.prototype.put=function(e,t,r){if(this._active.length)for(var n=this._active.length-1;n>=0;n--)this._active[n].put(e,t,r);else this._handlerFb(this._ident,"PUT",(0, i.utf32ToString)(e,t,r));},e.prototype.unhook=function(e,t){if(void 0===t&&(t=!0),this._active.length){var r=!1,i=this._active.length-1,n=!1;if(this._stack.paused&&(i=this._stack.loopPosition-1,r=t,n=this._stack.fallThrough,this._stack.paused=!1),!n&&!1===r){for(;i>=0&&!0!==(r=this._active[i].unhook(e));i--)if(r instanceof Promise)return this._stack.paused=!0,this._stack.loopPosition=i,this._stack.fallThrough=!1,r;i--;}for(;i>=0;i--)if((r=this._active[i].unhook(!1))instanceof Promise)return this._stack.paused=!0,this._stack.loopPosition=i,this._stack.fallThrough=!0,r}else this._handlerFb(this._ident,"UNHOOK",e);this._active=s,this._ident=0;},e}();t.DcsParser=a;var c=new n.Params;c.addParam(0);var l=function(){function e(e){this._handler=e,this._data="",this._params=c,this._hitLimit=!1;}return e.prototype.hook=function(e){this._params=e.length>1||e.params[0]?e.clone():c,this._data="",this._hitLimit=!1;},e.prototype.put=function(e,t,r){this._hitLimit||(this._data+=(0, i.utf32ToString)(e,t,r),this._data.length>o.PAYLOAD_LIMIT&&(this._data="",this._hitLimit=!0));},e.prototype.unhook=function(e){var t=this,r=!1;if(this._hitLimit)r=!1;else if(e&&(r=this._handler(this._data,this._params))instanceof Promise)return r.then((function(e){return t._params=c,t._data="",t._hitLimit=!1,e}));return this._params=c,this._data="",this._hitLimit=!1,r},e}();t.DcsHandler=l;},2015:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);});Object.defineProperty(t,"__esModule",{value:!0}),t.EscapeSequenceParser=t.VT500_TRANSITION_TABLE=t.TransitionTable=void 0;var o=r(844),s=r(8273),a=r(8742),c=r(6242),l=r(6351),h=function(){function e(e){this.table=new Uint8Array(e);}return e.prototype.setDefault=function(e,t){(0, s.fill)(this.table,e<<4|t);},e.prototype.add=function(e,t,r,i){this.table[t<<8|e]=r<<4|i;},e.prototype.addMany=function(e,t,r,i){for(var n=0;n<e.length;n++)this.table[t<<8|e[n]]=r<<4|i;},e}();t.TransitionTable=h;var u=160;t.VT500_TRANSITION_TABLE=function(){var e=new h(4095),t=Array.apply(null,Array(256)).map((function(e,t){return t})),r=function(e,r){return t.slice(e,r)},i=r(32,127),n=r(0,24);n.push(25),n.push.apply(n,r(28,32));var o,s=r(0,14);for(o in e.setDefault(1,0),e.addMany(i,0,2,0),s)e.addMany([24,26,153,154],o,3,0),e.addMany(r(128,144),o,3,0),e.addMany(r(144,152),o,3,0),e.add(156,o,0,0),e.add(27,o,11,1),e.add(157,o,4,8),e.addMany([152,158,159],o,0,7),e.add(155,o,11,3),e.add(144,o,11,9);return e.addMany(n,0,3,0),e.addMany(n,1,3,1),e.add(127,1,0,1),e.addMany(n,8,0,8),e.addMany(n,3,3,3),e.add(127,3,0,3),e.addMany(n,4,3,4),e.add(127,4,0,4),e.addMany(n,6,3,6),e.addMany(n,5,3,5),e.add(127,5,0,5),e.addMany(n,2,3,2),e.add(127,2,0,2),e.add(93,1,4,8),e.addMany(i,8,5,8),e.add(127,8,5,8),e.addMany([156,27,24,26,7],8,6,0),e.addMany(r(28,32),8,0,8),e.addMany([88,94,95],1,0,7),e.addMany(i,7,0,7),e.addMany(n,7,0,7),e.add(156,7,0,0),e.add(127,7,0,7),e.add(91,1,11,3),e.addMany(r(64,127),3,7,0),e.addMany(r(48,60),3,8,4),e.addMany([60,61,62,63],3,9,4),e.addMany(r(48,60),4,8,4),e.addMany(r(64,127),4,7,0),e.addMany([60,61,62,63],4,0,6),e.addMany(r(32,64),6,0,6),e.add(127,6,0,6),e.addMany(r(64,127),6,0,0),e.addMany(r(32,48),3,9,5),e.addMany(r(32,48),5,9,5),e.addMany(r(48,64),5,0,6),e.addMany(r(64,127),5,7,0),e.addMany(r(32,48),4,9,5),e.addMany(r(32,48),1,9,2),e.addMany(r(32,48),2,9,2),e.addMany(r(48,127),2,10,0),e.addMany(r(48,80),1,10,0),e.addMany(r(81,88),1,10,0),e.addMany([89,90,92],1,10,0),e.addMany(r(96,127),1,10,0),e.add(80,1,11,9),e.addMany(n,9,0,9),e.add(127,9,0,9),e.addMany(r(28,32),9,0,9),e.addMany(r(32,48),9,9,12),e.addMany(r(48,60),9,8,10),e.addMany([60,61,62,63],9,9,10),e.addMany(n,11,0,11),e.addMany(r(32,128),11,0,11),e.addMany(r(28,32),11,0,11),e.addMany(n,10,0,10),e.add(127,10,0,10),e.addMany(r(28,32),10,0,10),e.addMany(r(48,60),10,8,10),e.addMany([60,61,62,63],10,0,11),e.addMany(r(32,48),10,9,12),e.addMany(n,12,0,12),e.add(127,12,0,12),e.addMany(r(28,32),12,0,12),e.addMany(r(32,48),12,9,12),e.addMany(r(48,64),12,0,11),e.addMany(r(64,127),12,12,13),e.addMany(r(64,127),10,12,13),e.addMany(r(64,127),9,12,13),e.addMany(n,13,13,13),e.addMany(i,13,13,13),e.add(127,13,0,13),e.addMany([27,156,24,26],13,14,0),e.add(u,0,2,0),e.add(u,8,5,8),e.add(u,6,0,6),e.add(u,11,0,11),e.add(u,13,13,13),e}();var f=function(e){function r(r){void 0===r&&(r=t.VT500_TRANSITION_TABLE);var i=e.call(this)||this;return i._transitions=r,i._parseStack={state:0,handlers:[],handlerPos:0,transition:0,chunkPos:0},i.initialState=0,i.currentState=i.initialState,i._params=new a.Params,i._params.addParam(0),i._collect=0,i.precedingCodepoint=0,i._printHandlerFb=function(e,t,r){},i._executeHandlerFb=function(e){},i._csiHandlerFb=function(e,t){},i._escHandlerFb=function(e){},i._errorHandlerFb=function(e){return e},i._printHandler=i._printHandlerFb,i._executeHandlers=Object.create(null),i._csiHandlers=Object.create(null),i._escHandlers=Object.create(null),i._oscParser=new c.OscParser,i._dcsParser=new l.DcsParser,i._errorHandler=i._errorHandlerFb,i.registerEscHandler({final:"\\"},(function(){return !0})),i}return n(r,e),r.prototype._identifier=function(e,t){void 0===t&&(t=[64,126]);var r=0;if(e.prefix){if(e.prefix.length>1)throw new Error("only one byte as prefix supported");if((r=e.prefix.charCodeAt(0))&&60>r||r>63)throw new Error("prefix must be in range 0x3c .. 0x3f")}if(e.intermediates){if(e.intermediates.length>2)throw new Error("only two bytes as intermediates are supported");for(var i=0;i<e.intermediates.length;++i){var n=e.intermediates.charCodeAt(i);if(32>n||n>47)throw new Error("intermediate must be in range 0x20 .. 0x2f");r<<=8,r|=n;}}if(1!==e.final.length)throw new Error("final must be a single byte");var o=e.final.charCodeAt(0);if(t[0]>o||o>t[1])throw new Error("final must be in range "+t[0]+" .. "+t[1]);return (r<<=8)|o},r.prototype.identToString=function(e){for(var t=[];e;)t.push(String.fromCharCode(255&e)),e>>=8;return t.reverse().join("")},r.prototype.dispose=function(){this._csiHandlers=Object.create(null),this._executeHandlers=Object.create(null),this._escHandlers=Object.create(null),this._oscParser.dispose(),this._dcsParser.dispose();},r.prototype.setPrintHandler=function(e){this._printHandler=e;},r.prototype.clearPrintHandler=function(){this._printHandler=this._printHandlerFb;},r.prototype.registerEscHandler=function(e,t){var r=this._identifier(e,[48,126]);void 0===this._escHandlers[r]&&(this._escHandlers[r]=[]);var i=this._escHandlers[r];return i.push(t),{dispose:function(){var e=i.indexOf(t);-1!==e&&i.splice(e,1);}}},r.prototype.clearEscHandler=function(e){this._escHandlers[this._identifier(e,[48,126])]&&delete this._escHandlers[this._identifier(e,[48,126])];},r.prototype.setEscHandlerFallback=function(e){this._escHandlerFb=e;},r.prototype.setExecuteHandler=function(e,t){this._executeHandlers[e.charCodeAt(0)]=t;},r.prototype.clearExecuteHandler=function(e){this._executeHandlers[e.charCodeAt(0)]&&delete this._executeHandlers[e.charCodeAt(0)];},r.prototype.setExecuteHandlerFallback=function(e){this._executeHandlerFb=e;},r.prototype.registerCsiHandler=function(e,t){var r=this._identifier(e);void 0===this._csiHandlers[r]&&(this._csiHandlers[r]=[]);var i=this._csiHandlers[r];return i.push(t),{dispose:function(){var e=i.indexOf(t);-1!==e&&i.splice(e,1);}}},r.prototype.clearCsiHandler=function(e){this._csiHandlers[this._identifier(e)]&&delete this._csiHandlers[this._identifier(e)];},r.prototype.setCsiHandlerFallback=function(e){this._csiHandlerFb=e;},r.prototype.registerDcsHandler=function(e,t){return this._dcsParser.registerHandler(this._identifier(e),t)},r.prototype.clearDcsHandler=function(e){this._dcsParser.clearHandler(this._identifier(e));},r.prototype.setDcsHandlerFallback=function(e){this._dcsParser.setHandlerFallback(e);},r.prototype.registerOscHandler=function(e,t){return this._oscParser.registerHandler(e,t)},r.prototype.clearOscHandler=function(e){this._oscParser.clearHandler(e);},r.prototype.setOscHandlerFallback=function(e){this._oscParser.setHandlerFallback(e);},r.prototype.setErrorHandler=function(e){this._errorHandler=e;},r.prototype.clearErrorHandler=function(){this._errorHandler=this._errorHandlerFb;},r.prototype.reset=function(){this.currentState=this.initialState,this._oscParser.reset(),this._dcsParser.reset(),this._params.reset(),this._params.addParam(0),this._collect=0,this.precedingCodepoint=0,0!==this._parseStack.state&&(this._parseStack.state=2,this._parseStack.handlers=[]);},r.prototype._preserveStack=function(e,t,r,i,n){this._parseStack.state=e,this._parseStack.handlers=t,this._parseStack.handlerPos=r,this._parseStack.transition=i,this._parseStack.chunkPos=n;},r.prototype.parse=function(e,t,r){var i,n=0,o=0,s=0;if(this._parseStack.state)if(2===this._parseStack.state)this._parseStack.state=0,s=this._parseStack.chunkPos+1;else {if(void 0===r||1===this._parseStack.state)throw this._parseStack.state=1,new Error("improper continuation due to previous async handler, giving up parsing");var a=this._parseStack.handlers,c=this._parseStack.handlerPos-1;switch(this._parseStack.state){case 3:if(!1===r&&c>-1)for(;c>=0&&!0!==(i=a[c](this._params));c--)if(i instanceof Promise)return this._parseStack.handlerPos=c,i;this._parseStack.handlers=[];break;case 4:if(!1===r&&c>-1)for(;c>=0&&!0!==(i=a[c]());c--)if(i instanceof Promise)return this._parseStack.handlerPos=c,i;this._parseStack.handlers=[];break;case 6:if(n=e[this._parseStack.chunkPos],i=this._dcsParser.unhook(24!==n&&26!==n,r))return i;27===n&&(this._parseStack.transition|=1),this._params.reset(),this._params.addParam(0),this._collect=0;break;case 5:if(n=e[this._parseStack.chunkPos],i=this._oscParser.end(24!==n&&26!==n,r))return i;27===n&&(this._parseStack.transition|=1),this._params.reset(),this._params.addParam(0),this._collect=0;}this._parseStack.state=0,s=this._parseStack.chunkPos+1,this.precedingCodepoint=0,this.currentState=15&this._parseStack.transition;}for(var l=s;l<t;++l){switch(n=e[l],(o=this._transitions.table[this.currentState<<8|(n<160?n:u)])>>4){case 2:for(var h=l+1;;++h){if(h>=t||(n=e[h])<32||n>126&&n<u){this._printHandler(e,l,h),l=h-1;break}if(++h>=t||(n=e[h])<32||n>126&&n<u){this._printHandler(e,l,h),l=h-1;break}if(++h>=t||(n=e[h])<32||n>126&&n<u){this._printHandler(e,l,h),l=h-1;break}if(++h>=t||(n=e[h])<32||n>126&&n<u){this._printHandler(e,l,h),l=h-1;break}}break;case 3:this._executeHandlers[n]?this._executeHandlers[n]():this._executeHandlerFb(n),this.precedingCodepoint=0;break;case 0:break;case 1:if(this._errorHandler({position:l,code:n,currentState:this.currentState,collect:this._collect,params:this._params,abort:!1}).abort)return;break;case 7:for(var f=(a=this._csiHandlers[this._collect<<8|n])?a.length-1:-1;f>=0&&!0!==(i=a[f](this._params));f--)if(i instanceof Promise)return this._preserveStack(3,a,f,o,l),i;f<0&&this._csiHandlerFb(this._collect<<8|n,this._params),this.precedingCodepoint=0;break;case 8:do{switch(n){case 59:this._params.addParam(0);break;case 58:this._params.addSubParam(-1);break;default:this._params.addDigit(n-48);}}while(++l<t&&(n=e[l])>47&&n<60);l--;break;case 9:this._collect<<=8,this._collect|=n;break;case 10:for(var _=this._escHandlers[this._collect<<8|n],d=_?_.length-1:-1;d>=0&&!0!==(i=_[d]());d--)if(i instanceof Promise)return this._preserveStack(4,_,d,o,l),i;d<0&&this._escHandlerFb(this._collect<<8|n),this.precedingCodepoint=0;break;case 11:this._params.reset(),this._params.addParam(0),this._collect=0;break;case 12:this._dcsParser.hook(this._collect<<8|n,this._params);break;case 13:for(var p=l+1;;++p)if(p>=t||24===(n=e[p])||26===n||27===n||n>127&&n<u){this._dcsParser.put(e,l,p),l=p-1;break}break;case 14:if(i=this._dcsParser.unhook(24!==n&&26!==n))return this._preserveStack(6,[],0,o,l),i;27===n&&(o|=1),this._params.reset(),this._params.addParam(0),this._collect=0,this.precedingCodepoint=0;break;case 4:this._oscParser.start();break;case 5:for(var v=l+1;;v++)if(v>=t||(n=e[v])<32||n>127&&n<u){this._oscParser.put(e,l,v),l=v-1;break}break;case 6:if(i=this._oscParser.end(24!==n&&26!==n))return this._preserveStack(5,[],0,o,l),i;27===n&&(o|=1),this._params.reset(),this._params.addParam(0),this._collect=0,this.precedingCodepoint=0;}this.currentState=15&o;}},r}(o.Disposable);t.EscapeSequenceParser=f;},6242:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.OscHandler=t.OscParser=void 0;var i=r(5770),n=r(482),o=[],s=function(){function e(){this._state=0,this._active=o,this._id=-1,this._handlers=Object.create(null),this._handlerFb=function(){},this._stack={paused:!1,loopPosition:0,fallThrough:!1};}return e.prototype.registerHandler=function(e,t){void 0===this._handlers[e]&&(this._handlers[e]=[]);var r=this._handlers[e];return r.push(t),{dispose:function(){var e=r.indexOf(t);-1!==e&&r.splice(e,1);}}},e.prototype.clearHandler=function(e){this._handlers[e]&&delete this._handlers[e];},e.prototype.setHandlerFallback=function(e){this._handlerFb=e;},e.prototype.dispose=function(){this._handlers=Object.create(null),this._handlerFb=function(){},this._active=o;},e.prototype.reset=function(){if(2===this._state)for(var e=this._stack.paused?this._stack.loopPosition-1:this._active.length-1;e>=0;--e)this._active[e].end(!1);this._stack.paused=!1,this._active=o,this._id=-1,this._state=0;},e.prototype._start=function(){if(this._active=this._handlers[this._id]||o,this._active.length)for(var e=this._active.length-1;e>=0;e--)this._active[e].start();else this._handlerFb(this._id,"START");},e.prototype._put=function(e,t,r){if(this._active.length)for(var i=this._active.length-1;i>=0;i--)this._active[i].put(e,t,r);else this._handlerFb(this._id,"PUT",(0, n.utf32ToString)(e,t,r));},e.prototype.start=function(){this.reset(),this._state=1;},e.prototype.put=function(e,t,r){if(3!==this._state){if(1===this._state)for(;t<r;){var i=e[t++];if(59===i){this._state=2,this._start();break}if(i<48||57<i)return void(this._state=3);-1===this._id&&(this._id=0),this._id=10*this._id+i-48;}2===this._state&&r-t>0&&this._put(e,t,r);}},e.prototype.end=function(e,t){if(void 0===t&&(t=!0),0!==this._state){if(3!==this._state)if(1===this._state&&this._start(),this._active.length){var r=!1,i=this._active.length-1,n=!1;if(this._stack.paused&&(i=this._stack.loopPosition-1,r=t,n=this._stack.fallThrough,this._stack.paused=!1),!n&&!1===r){for(;i>=0&&!0!==(r=this._active[i].end(e));i--)if(r instanceof Promise)return this._stack.paused=!0,this._stack.loopPosition=i,this._stack.fallThrough=!1,r;i--;}for(;i>=0;i--)if((r=this._active[i].end(!1))instanceof Promise)return this._stack.paused=!0,this._stack.loopPosition=i,this._stack.fallThrough=!0,r}else this._handlerFb(this._id,"END",e);this._active=o,this._id=-1,this._state=0;}},e}();t.OscParser=s;var a=function(){function e(e){this._handler=e,this._data="",this._hitLimit=!1;}return e.prototype.start=function(){this._data="",this._hitLimit=!1;},e.prototype.put=function(e,t,r){this._hitLimit||(this._data+=(0, n.utf32ToString)(e,t,r),this._data.length>i.PAYLOAD_LIMIT&&(this._data="",this._hitLimit=!0));},e.prototype.end=function(e){var t=this,r=!1;if(this._hitLimit)r=!1;else if(e&&(r=this._handler(this._data))instanceof Promise)return r.then((function(e){return t._data="",t._hitLimit=!1,e}));return this._data="",this._hitLimit=!1,r},e}();t.OscHandler=a;},8742:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.Params=void 0;var r=2147483647,i=function(){function e(e,t){if(void 0===e&&(e=32),void 0===t&&(t=32),this.maxLength=e,this.maxSubParamsLength=t,t>256)throw new Error("maxSubParamsLength must not be greater than 256");this.params=new Int32Array(e),this.length=0,this._subParams=new Int32Array(t),this._subParamsLength=0,this._subParamsIdx=new Uint16Array(e),this._rejectDigits=!1,this._rejectSubDigits=!1,this._digitIsSub=!1;}return e.fromArray=function(t){var r=new e;if(!t.length)return r;for(var i=Array.isArray(t[0])?1:0;i<t.length;++i){var n=t[i];if(Array.isArray(n))for(var o=0;o<n.length;++o)r.addSubParam(n[o]);else r.addParam(n);}return r},e.prototype.clone=function(){var t=new e(this.maxLength,this.maxSubParamsLength);return t.params.set(this.params),t.length=this.length,t._subParams.set(this._subParams),t._subParamsLength=this._subParamsLength,t._subParamsIdx.set(this._subParamsIdx),t._rejectDigits=this._rejectDigits,t._rejectSubDigits=this._rejectSubDigits,t._digitIsSub=this._digitIsSub,t},e.prototype.toArray=function(){for(var e=[],t=0;t<this.length;++t){e.push(this.params[t]);var r=this._subParamsIdx[t]>>8,i=255&this._subParamsIdx[t];i-r>0&&e.push(Array.prototype.slice.call(this._subParams,r,i));}return e},e.prototype.reset=function(){this.length=0,this._subParamsLength=0,this._rejectDigits=!1,this._rejectSubDigits=!1,this._digitIsSub=!1;},e.prototype.addParam=function(e){if(this._digitIsSub=!1,this.length>=this.maxLength)this._rejectDigits=!0;else {if(e<-1)throw new Error("values lesser than -1 are not allowed");this._subParamsIdx[this.length]=this._subParamsLength<<8|this._subParamsLength,this.params[this.length++]=e>r?r:e;}},e.prototype.addSubParam=function(e){if(this._digitIsSub=!0,this.length)if(this._rejectDigits||this._subParamsLength>=this.maxSubParamsLength)this._rejectSubDigits=!0;else {if(e<-1)throw new Error("values lesser than -1 are not allowed");this._subParams[this._subParamsLength++]=e>r?r:e,this._subParamsIdx[this.length-1]++;}},e.prototype.hasSubParams=function(e){return (255&this._subParamsIdx[e])-(this._subParamsIdx[e]>>8)>0},e.prototype.getSubParams=function(e){var t=this._subParamsIdx[e]>>8,r=255&this._subParamsIdx[e];return r-t>0?this._subParams.subarray(t,r):null},e.prototype.getSubParamsAll=function(){for(var e={},t=0;t<this.length;++t){var r=this._subParamsIdx[t]>>8,i=255&this._subParamsIdx[t];i-r>0&&(e[t]=this._subParams.slice(r,i));}return e},e.prototype.addDigit=function(e){var t;if(!(this._rejectDigits||!(t=this._digitIsSub?this._subParamsLength:this.length)||this._digitIsSub&&this._rejectSubDigits)){var i=this._digitIsSub?this._subParams:this.params,n=i[t-1];i[t-1]=~n?Math.min(10*n+e,r):e;}},e}();t.Params=i;},5741:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.AddonManager=void 0;var r=function(){function e(){this._addons=[];}return e.prototype.dispose=function(){for(var e=this._addons.length-1;e>=0;e--)this._addons[e].instance.dispose();},e.prototype.loadAddon=function(e,t){var r=this,i={instance:t,dispose:t.dispose,isDisposed:!1};this._addons.push(i),t.dispose=function(){return r._wrappedAddonDispose(i)},t.activate(e);},e.prototype._wrappedAddonDispose=function(e){if(!e.isDisposed){for(var t=-1,r=0;r<this._addons.length;r++)if(this._addons[r]===e){t=r;break}if(-1===t)throw new Error("Could not dispose an addon that has not been loaded");e.isDisposed=!0,e.dispose.apply(e.instance),this._addons.splice(t,1);}},e}();t.AddonManager=r;},8771:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.BufferApiView=void 0;var i=r(3785),n=r(511),o=function(){function e(e,t){this._buffer=e,this.type=t;}return e.prototype.init=function(e){return this._buffer=e,this},Object.defineProperty(e.prototype,"cursorY",{get:function(){return this._buffer.y},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"cursorX",{get:function(){return this._buffer.x},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"viewportY",{get:function(){return this._buffer.ydisp},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"baseY",{get:function(){return this._buffer.ybase},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"length",{get:function(){return this._buffer.lines.length},enumerable:!1,configurable:!0}),e.prototype.getLine=function(e){var t=this._buffer.lines.get(e);if(t)return new i.BufferLineApiView(t)},e.prototype.getNullCell=function(){return new n.CellData},e}();t.BufferApiView=o;},3785:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.BufferLineApiView=void 0;var i=r(511),n=function(){function e(e){this._line=e;}return Object.defineProperty(e.prototype,"isWrapped",{get:function(){return this._line.isWrapped},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"length",{get:function(){return this._line.length},enumerable:!1,configurable:!0}),e.prototype.getCell=function(e,t){if(!(e<0||e>=this._line.length))return t?(this._line.loadCell(e,t),t):this._line.loadCell(e,new i.CellData)},e.prototype.translateToString=function(e,t,r){return this._line.translateToString(e,t,r)},e}();t.BufferLineApiView=n;},8285:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.BufferNamespaceApi=void 0;var i=r(8771),n=r(8460),o=function(){function e(e){var t=this;this._core=e,this._onBufferChange=new n.EventEmitter,this._normal=new i.BufferApiView(this._core.buffers.normal,"normal"),this._alternate=new i.BufferApiView(this._core.buffers.alt,"alternate"),this._core.buffers.onBufferActivate((function(){return t._onBufferChange.fire(t.active)}));}return Object.defineProperty(e.prototype,"onBufferChange",{get:function(){return this._onBufferChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"active",{get:function(){if(this._core.buffers.active===this._core.buffers.normal)return this.normal;if(this._core.buffers.active===this._core.buffers.alt)return this.alternate;throw new Error("Active buffer is neither normal nor alternate")},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"normal",{get:function(){return this._normal.init(this._core.buffers.normal)},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"alternate",{get:function(){return this._alternate.init(this._core.buffers.alt)},enumerable:!1,configurable:!0}),e}();t.BufferNamespaceApi=o;},7975:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.ParserApi=void 0;var r=function(){function e(e){this._core=e;}return e.prototype.registerCsiHandler=function(e,t){return this._core.registerCsiHandler(e,(function(e){return t(e.toArray())}))},e.prototype.addCsiHandler=function(e,t){return this.registerCsiHandler(e,t)},e.prototype.registerDcsHandler=function(e,t){return this._core.registerDcsHandler(e,(function(e,r){return t(e,r.toArray())}))},e.prototype.addDcsHandler=function(e,t){return this.registerDcsHandler(e,t)},e.prototype.registerEscHandler=function(e,t){return this._core.registerEscHandler(e,t)},e.prototype.addEscHandler=function(e,t){return this.registerEscHandler(e,t)},e.prototype.registerOscHandler=function(e,t){return this._core.registerOscHandler(e,t)},e.prototype.addOscHandler=function(e,t){return this.registerOscHandler(e,t)},e}();t.ParserApi=r;},7090:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.UnicodeApi=void 0;var r=function(){function e(e){this._core=e;}return e.prototype.register=function(e){this._core.unicodeService.register(e);},Object.defineProperty(e.prototype,"versions",{get:function(){return this._core.unicodeService.versions},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"activeVersion",{get:function(){return this._core.unicodeService.activeVersion},set:function(e){this._core.unicodeService.activeVersion=e;},enumerable:!1,configurable:!0}),e}();t.UnicodeApi=r;},744:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.BufferService=t.MINIMUM_ROWS=t.MINIMUM_COLS=void 0;var a=r(2585),c=r(5295),l=r(8460),h=r(844);t.MINIMUM_COLS=2,t.MINIMUM_ROWS=1;var u=function(e){function r(r){var i=e.call(this)||this;return i._optionsService=r,i.isUserScrolling=!1,i._onResize=new l.EventEmitter,i._onScroll=new l.EventEmitter,i.cols=Math.max(r.rawOptions.cols||0,t.MINIMUM_COLS),i.rows=Math.max(r.rawOptions.rows||0,t.MINIMUM_ROWS),i.buffers=new c.BufferSet(r,i),i}return n(r,e),Object.defineProperty(r.prototype,"onResize",{get:function(){return this._onResize.event},enumerable:!1,configurable:!0}),Object.defineProperty(r.prototype,"onScroll",{get:function(){return this._onScroll.event},enumerable:!1,configurable:!0}),Object.defineProperty(r.prototype,"buffer",{get:function(){return this.buffers.active},enumerable:!1,configurable:!0}),r.prototype.dispose=function(){e.prototype.dispose.call(this),this.buffers.dispose();},r.prototype.resize=function(e,t){this.cols=e,this.rows=t,this.buffers.resize(e,t),this.buffers.setupTabStops(this.cols),this._onResize.fire({cols:e,rows:t});},r.prototype.reset=function(){this.buffers.reset(),this.isUserScrolling=!1;},r.prototype.scroll=function(e,t){void 0===t&&(t=!1);var r,i=this.buffer;(r=this._cachedBlankLine)&&r.length===this.cols&&r.getFg(0)===e.fg&&r.getBg(0)===e.bg||(r=i.getBlankLine(e,t),this._cachedBlankLine=r),r.isWrapped=t;var n=i.ybase+i.scrollTop,o=i.ybase+i.scrollBottom;if(0===i.scrollTop){var s=i.lines.isFull;o===i.lines.length-1?s?i.lines.recycle().copyFrom(r):i.lines.push(r.clone()):i.lines.splice(o+1,0,r.clone()),s?this.isUserScrolling&&(i.ydisp=Math.max(i.ydisp-1,0)):(i.ybase++,this.isUserScrolling||i.ydisp++);}else {var a=o-n+1;i.lines.shiftElements(n+1,a-1,-1),i.lines.set(o,r.clone());}this.isUserScrolling||(i.ydisp=i.ybase),this._onScroll.fire(i.ydisp);},r.prototype.scrollLines=function(e,t,r){var i=this.buffer;if(e<0){if(0===i.ydisp)return;this.isUserScrolling=!0;}else e+i.ydisp>=i.ybase&&(this.isUserScrolling=!1);var n=i.ydisp;i.ydisp=Math.max(Math.min(i.ydisp+e,i.ybase),0),n!==i.ydisp&&(t||this._onScroll.fire(i.ydisp));},r.prototype.scrollPages=function(e){this.scrollLines(e*(this.rows-1));},r.prototype.scrollToTop=function(){this.scrollLines(-this.buffer.ydisp);},r.prototype.scrollToBottom=function(){this.scrollLines(this.buffer.ybase-this.buffer.ydisp);},r.prototype.scrollToLine=function(e){var t=e-this.buffer.ydisp;0!==t&&this.scrollLines(t);},o([s(0,a.IOptionsService)],r)}(h.Disposable);t.BufferService=u;},7994:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.CharsetService=void 0;var r=function(){function e(){this.glevel=0,this._charsets=[];}return e.prototype.reset=function(){this.charset=void 0,this._charsets=[],this.glevel=0;},e.prototype.setgLevel=function(e){this.glevel=e,this.charset=this._charsets[e];},e.prototype.setgCharset=function(e,t){this._charsets[e]=t,this.glevel===e&&(this.charset=t);},e}();t.CharsetService=r;},1753:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},o=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.CoreMouseService=void 0;var s=r(2585),a=r(8460),c={NONE:{events:0,restrict:function(){return !1}},X10:{events:1,restrict:function(e){return 4!==e.button&&1===e.action&&(e.ctrl=!1,e.alt=!1,e.shift=!1,!0)}},VT200:{events:19,restrict:function(e){return 32!==e.action}},DRAG:{events:23,restrict:function(e){return 32!==e.action||3!==e.button}},ANY:{events:31,restrict:function(e){return !0}}};function l(e,t){var r=(e.ctrl?16:0)|(e.shift?4:0)|(e.alt?8:0);return 4===e.button?(r|=64,r|=e.action):(r|=3&e.button,4&e.button&&(r|=64),8&e.button&&(r|=128),32===e.action?r|=32:0!==e.action||t||(r|=3)),r}var h=String.fromCharCode,u={DEFAULT:function(e){var t=[l(e,!1)+32,e.col+32,e.row+32];return t[0]>255||t[1]>255||t[2]>255?"":"[M"+h(t[0])+h(t[1])+h(t[2])},SGR:function(e){var t=0===e.action&&4!==e.button?"m":"M";return "[<"+l(e,!0)+";"+e.col+";"+e.row+t}},f=function(){function e(e,t){var r,i,n,s;this._bufferService=e,this._coreService=t,this._protocols={},this._encodings={},this._activeProtocol="",this._activeEncoding="",this._onProtocolChange=new a.EventEmitter,this._lastEvent=null;try{for(var l=o(Object.keys(c)),h=l.next();!h.done;h=l.next()){var f=h.value;this.addProtocol(f,c[f]);}}catch(e){r={error:e};}finally{try{h&&!h.done&&(i=l.return)&&i.call(l);}finally{if(r)throw r.error}}try{for(var _=o(Object.keys(u)),d=_.next();!d.done;d=_.next()){var p=d.value;this.addEncoding(p,u[p]);}}catch(e){n={error:e};}finally{try{d&&!d.done&&(s=_.return)&&s.call(_);}finally{if(n)throw n.error}}this.reset();}return e.prototype.addProtocol=function(e,t){this._protocols[e]=t;},e.prototype.addEncoding=function(e,t){this._encodings[e]=t;},Object.defineProperty(e.prototype,"activeProtocol",{get:function(){return this._activeProtocol},set:function(e){if(!this._protocols[e])throw new Error('unknown protocol "'+e+'"');this._activeProtocol=e,this._onProtocolChange.fire(this._protocols[e].events);},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"areMouseEventsActive",{get:function(){return 0!==this._protocols[this._activeProtocol].events},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"activeEncoding",{get:function(){return this._activeEncoding},set:function(e){if(!this._encodings[e])throw new Error('unknown encoding "'+e+'"');this._activeEncoding=e;},enumerable:!1,configurable:!0}),e.prototype.reset=function(){this.activeProtocol="NONE",this.activeEncoding="DEFAULT",this._lastEvent=null;},Object.defineProperty(e.prototype,"onProtocolChange",{get:function(){return this._onProtocolChange.event},enumerable:!1,configurable:!0}),e.prototype.triggerMouseEvent=function(e){if(e.col<0||e.col>=this._bufferService.cols||e.row<0||e.row>=this._bufferService.rows)return !1;if(4===e.button&&32===e.action)return !1;if(3===e.button&&32!==e.action)return !1;if(4!==e.button&&(2===e.action||3===e.action))return !1;if(e.col++,e.row++,32===e.action&&this._lastEvent&&this._compareEvents(this._lastEvent,e))return !1;if(!this._protocols[this._activeProtocol].restrict(e))return !1;var t=this._encodings[this._activeEncoding](e);return t&&("DEFAULT"===this._activeEncoding?this._coreService.triggerBinaryEvent(t):this._coreService.triggerDataEvent(t,!0)),this._lastEvent=e,!0},e.prototype.explainEvents=function(e){return {down:!!(1&e),up:!!(2&e),drag:!!(4&e),move:!!(8&e),wheel:!!(16&e)}},e.prototype._compareEvents=function(e,t){return e.col===t.col&&e.row===t.row&&e.button===t.button&&e.action===t.action&&e.ctrl===t.ctrl&&e.alt===t.alt&&e.shift===t.shift},i([n(0,s.IBufferService),n(1,s.ICoreService)],e)}();t.CoreMouseService=f;},6975:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},s=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.CoreService=void 0;var a=r(2585),c=r(8460),l=r(1439),h=r(844),u=Object.freeze({insertMode:!1}),f=Object.freeze({applicationCursorKeys:!1,applicationKeypad:!1,bracketedPasteMode:!1,origin:!1,reverseWraparound:!1,sendFocus:!1,wraparound:!0}),_=function(e){function t(t,r,i,n){var o=e.call(this)||this;return o._bufferService=r,o._logService=i,o._optionsService=n,o.isCursorInitialized=!1,o.isCursorHidden=!1,o._onData=o.register(new c.EventEmitter),o._onUserInput=o.register(new c.EventEmitter),o._onBinary=o.register(new c.EventEmitter),o._scrollToBottom=t,o.register({dispose:function(){return o._scrollToBottom=void 0}}),o.modes=(0, l.clone)(u),o.decPrivateModes=(0, l.clone)(f),o}return n(t,e),Object.defineProperty(t.prototype,"onData",{get:function(){return this._onData.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onUserInput",{get:function(){return this._onUserInput.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onBinary",{get:function(){return this._onBinary.event},enumerable:!1,configurable:!0}),t.prototype.reset=function(){this.modes=(0, l.clone)(u),this.decPrivateModes=(0, l.clone)(f);},t.prototype.triggerDataEvent=function(e,t){if(void 0===t&&(t=!1),!this._optionsService.rawOptions.disableStdin){var r=this._bufferService.buffer;r.ybase!==r.ydisp&&this._scrollToBottom(),t&&this._onUserInput.fire(),this._logService.debug('sending data "'+e+'"',(function(){return e.split("").map((function(e){return e.charCodeAt(0)}))})),this._onData.fire(e);}},t.prototype.triggerBinaryEvent=function(e){this._optionsService.rawOptions.disableStdin||(this._logService.debug('sending binary "'+e+'"',(function(){return e.split("").map((function(e){return e.charCodeAt(0)}))})),this._onBinary.fire(e));},o([s(1,a.IBufferService),s(2,a.ILogService),s(3,a.IOptionsService)],t)}(h.Disposable);t.CoreService=_;},9074:function(e,t,r){var i,n=this&&this.__extends||(i=function(e,t){return i=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(e,t){e.__proto__=t;}||function(e,t){for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(e[r]=t[r]);},i(e,t)},function(e,t){if("function"!=typeof t&&null!==t)throw new TypeError("Class extends value "+String(t)+" is not a constructor or null");function r(){this.constructor=e;}i(e,t),e.prototype=null===t?Object.create(t):(r.prototype=t.prototype,new r);}),o=this&&this.__generator||function(e,t){var r,i,n,o,s={label:0,sent:function(){if(1&n[0])throw n[1];return n[1]},trys:[],ops:[]};return o={next:a(0),throw:a(1),return:a(2)},"function"==typeof Symbol&&(o[Symbol.iterator]=function(){return this}),o;function a(o){return function(a){return function(o){if(r)throw new TypeError("Generator is already executing.");for(;s;)try{if(r=1,i&&(n=2&o[0]?i.return:o[0]?i.throw||((n=i.return)&&n.call(i),0):i.next)&&!(n=n.call(i,o[1])).done)return n;switch(i=0,n&&(o=[2&o[0],n.value]),o[0]){case 0:case 1:n=o;break;case 4:return s.label++,{value:o[1],done:!1};case 5:s.label++,i=o[1],o=[0];continue;case 7:o=s.ops.pop(),s.trys.pop();continue;default:if(!((n=(n=s.trys).length>0&&n[n.length-1])||6!==o[0]&&2!==o[0])){s=0;continue}if(3===o[0]&&(!n||o[1]>n[0]&&o[1]<n[3])){s.label=o[1];break}if(6===o[0]&&s.label<n[1]){s.label=n[1],n=o;break}if(n&&s.label<n[2]){s.label=n[2],s.ops.push(o);break}n[2]&&s.ops.pop(),s.trys.pop();continue}o=t.call(e,s);}catch(e){o=[6,e],i=0;}finally{r=n=0;}if(5&o[0])throw o[1];return {value:o[0]?o[1]:void 0,done:!0}}([o,a])}}},s=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")};Object.defineProperty(t,"__esModule",{value:!0}),t.DecorationService=void 0;var a=r(8055),c=r(8460),l=r(844),h=r(6106),u=function(e){function t(){var t=e.call(this)||this;return t._decorations=new h.SortedList((function(e){return e.marker.line})),t._onDecorationRegistered=t.register(new c.EventEmitter),t._onDecorationRemoved=t.register(new c.EventEmitter),t}return n(t,e),Object.defineProperty(t.prototype,"onDecorationRegistered",{get:function(){return this._onDecorationRegistered.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"onDecorationRemoved",{get:function(){return this._onDecorationRemoved.event},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"decorations",{get:function(){return this._decorations.values()},enumerable:!1,configurable:!0}),t.prototype.registerDecoration=function(e){var t=this;if(!e.marker.isDisposed){var r=new f(e);if(r){var i=r.marker.onDispose((function(){return r.dispose()}));r.onDispose((function(){r&&(t._decorations.delete(r)&&t._onDecorationRemoved.fire(r),i.dispose());})),this._decorations.insert(r),this._onDecorationRegistered.fire(r);}return r}},t.prototype.reset=function(){var e,t;try{for(var r=s(this._decorations.values()),i=r.next();!i.done;i=r.next())i.value.dispose();}catch(t){e={error:t};}finally{try{i&&!i.done&&(t=r.return)&&t.call(r);}finally{if(e)throw e.error}}this._decorations.clear();},t.prototype.getDecorationsAtLine=function(e){return o(this,(function(t){return [2,this._decorations.getKeyIterator(e)]}))},t.prototype.getDecorationsAtCell=function(e,t,r){var i,n,a,c,l,h,u,f,_,d,p;return o(this,(function(o){switch(o.label){case 0:i=0,n=0,o.label=1;case 1:o.trys.push([1,6,7,8]),a=s(this._decorations.getKeyIterator(t)),c=a.next(),o.label=2;case 2:return c.done?[3,5]:(l=c.value,i=null!==(_=l.options.x)&&void 0!==_?_:0,n=i+(null!==(d=l.options.width)&&void 0!==d?d:1),!(e>=i&&e<n)||r&&(null!==(p=l.options.layer)&&void 0!==p?p:"bottom")!==r?[3,4]:[4,l]);case 3:o.sent(),o.label=4;case 4:return c=a.next(),[3,2];case 5:return [3,8];case 6:return h=o.sent(),u={error:h},[3,8];case 7:try{c&&!c.done&&(f=a.return)&&f.call(a);}finally{if(u)throw u.error}return [7];case 8:return [2]}}))},t.prototype.dispose=function(){var e,t;try{for(var r=s(this._decorations.values()),i=r.next();!i.done;i=r.next()){var n=i.value;this._onDecorationRemoved.fire(n);}}catch(t){e={error:t};}finally{try{i&&!i.done&&(t=r.return)&&t.call(r);}finally{if(e)throw e.error}}this.reset();},t}(l.Disposable);t.DecorationService=u;var f=function(e){function t(t){var r=e.call(this)||this;return r.options=t,r.isDisposed=!1,r.onRenderEmitter=r.register(new c.EventEmitter),r.onRender=r.onRenderEmitter.event,r._onDispose=r.register(new c.EventEmitter),r.onDispose=r._onDispose.event,r._cachedBg=null,r._cachedFg=null,r.marker=t.marker,r.options.overviewRulerOptions&&!r.options.overviewRulerOptions.position&&(r.options.overviewRulerOptions.position="full"),r}return n(t,e),Object.defineProperty(t.prototype,"backgroundColorRGB",{get:function(){return null===this._cachedBg&&(this.options.backgroundColor?this._cachedBg=a.css.toColor(this.options.backgroundColor):this._cachedBg=void 0),this._cachedBg},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"foregroundColorRGB",{get:function(){return null===this._cachedFg&&(this.options.foregroundColor?this._cachedFg=a.css.toColor(this.options.foregroundColor):this._cachedFg=void 0),this._cachedFg},enumerable:!1,configurable:!0}),t.prototype.dispose=function(){this._isDisposed||(this._isDisposed=!0,this._onDispose.fire(),e.prototype.dispose.call(this));},t}(l.Disposable);},3730:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}};Object.defineProperty(t,"__esModule",{value:!0}),t.DirtyRowService=void 0;var o=r(2585),s=function(){function e(e){this._bufferService=e,this.clearRange();}return Object.defineProperty(e.prototype,"start",{get:function(){return this._start},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"end",{get:function(){return this._end},enumerable:!1,configurable:!0}),e.prototype.clearRange=function(){this._start=this._bufferService.buffer.y,this._end=this._bufferService.buffer.y;},e.prototype.markDirty=function(e){e<this._start?this._start=e:e>this._end&&(this._end=e);},e.prototype.markRangeDirty=function(e,t){if(e>t){var r=e;e=t,t=r;}e<this._start&&(this._start=e),t>this._end&&(this._end=t);},e.prototype.markAllDirty=function(){this.markRangeDirty(0,this._bufferService.rows-1);},i([n(0,o.IBufferService)],e)}();t.DirtyRowService=s;},4348:function(e,t,r){var i=this&&this.__values||function(e){var t="function"==typeof Symbol&&Symbol.iterator,r=t&&e[t],i=0;if(r)return r.call(e);if(e&&"number"==typeof e.length)return {next:function(){return e&&i>=e.length&&(e=void 0),{value:e&&e[i++],done:!e}}};throw new TypeError(t?"Object is not iterable.":"Symbol.iterator is not defined.")},n=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s},o=this&&this.__spreadArray||function(e,t,r){if(r||2===arguments.length)for(var i,n=0,o=t.length;n<o;n++)!i&&n in t||(i||(i=Array.prototype.slice.call(t,0,n)),i[n]=t[n]);return e.concat(i||Array.prototype.slice.call(t))};Object.defineProperty(t,"__esModule",{value:!0}),t.InstantiationService=t.ServiceCollection=void 0;var s=r(2585),a=r(8343),c=function(){function e(){for(var e,t,r=[],o=0;o<arguments.length;o++)r[o]=arguments[o];this._entries=new Map;try{for(var s=i(r),a=s.next();!a.done;a=s.next()){var c=n(a.value,2),l=c[0],h=c[1];this.set(l,h);}}catch(t){e={error:t};}finally{try{a&&!a.done&&(t=s.return)&&t.call(s);}finally{if(e)throw e.error}}}return e.prototype.set=function(e,t){var r=this._entries.get(e);return this._entries.set(e,t),r},e.prototype.forEach=function(e){this._entries.forEach((function(t,r){return e(r,t)}));},e.prototype.has=function(e){return this._entries.has(e)},e.prototype.get=function(e){return this._entries.get(e)},e}();t.ServiceCollection=c;var l=function(){function e(){this._services=new c,this._services.set(s.IInstantiationService,this);}return e.prototype.setService=function(e,t){this._services.set(e,t);},e.prototype.getService=function(e){return this._services.get(e)},e.prototype.createInstance=function(e){for(var t,r,s=[],c=1;c<arguments.length;c++)s[c-1]=arguments[c];var l=(0, a.getServiceDependencies)(e).sort((function(e,t){return e.index-t.index})),h=[];try{for(var u=i(l),f=u.next();!f.done;f=u.next()){var _=f.value,d=this._services.get(_.id);if(!d)throw new Error("[createInstance] "+e.name+" depends on UNKNOWN service "+_.id+".");h.push(d);}}catch(e){t={error:e};}finally{try{f&&!f.done&&(r=u.return)&&r.call(u);}finally{if(t)throw t.error}}var p=l.length>0?l[0].index:s.length;if(s.length!==p)throw new Error("[createInstance] First service dependency of "+e.name+" at position "+(p+1)+" conflicts with "+s.length+" static arguments");return new(e.bind.apply(e,o([void 0],n(o(o([],n(s),!1),n(h),!1)),!1)))},e}();t.InstantiationService=l;},7866:function(e,t,r){var i=this&&this.__decorate||function(e,t,r,i){var n,o=arguments.length,s=o<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,r):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)s=Reflect.decorate(e,t,r,i);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,r,s):n(t,r))||s);return o>3&&s&&Object.defineProperty(t,r,s),s},n=this&&this.__param||function(e,t){return function(r,i){t(r,i,e);}},o=this&&this.__read||function(e,t){var r="function"==typeof Symbol&&e[Symbol.iterator];if(!r)return e;var i,n,o=r.call(e),s=[];try{for(;(void 0===t||t-- >0)&&!(i=o.next()).done;)s.push(i.value);}catch(e){n={error:e};}finally{try{i&&!i.done&&(r=o.return)&&r.call(o);}finally{if(n)throw n.error}}return s},s=this&&this.__spreadArray||function(e,t,r){if(r||2===arguments.length)for(var i,n=0,o=t.length;n<o;n++)!i&&n in t||(i||(i=Array.prototype.slice.call(t,0,n)),i[n]=t[n]);return e.concat(i||Array.prototype.slice.call(t))};Object.defineProperty(t,"__esModule",{value:!0}),t.LogService=void 0;var a=r(2585),c={debug:a.LogLevelEnum.DEBUG,info:a.LogLevelEnum.INFO,warn:a.LogLevelEnum.WARN,error:a.LogLevelEnum.ERROR,off:a.LogLevelEnum.OFF},l=function(){function e(e){var t=this;this._optionsService=e,this.logLevel=a.LogLevelEnum.OFF,this._updateLogLevel(),this._optionsService.onOptionChange((function(e){"logLevel"===e&&t._updateLogLevel();}));}return e.prototype._updateLogLevel=function(){this.logLevel=c[this._optionsService.rawOptions.logLevel];},e.prototype._evalLazyOptionalParams=function(e){for(var t=0;t<e.length;t++)"function"==typeof e[t]&&(e[t]=e[t]());},e.prototype._log=function(e,t,r){this._evalLazyOptionalParams(r),e.call.apply(e,s([console,"xterm.js: "+t],o(r),!1));},e.prototype.debug=function(e){for(var t=[],r=1;r<arguments.length;r++)t[r-1]=arguments[r];this.logLevel<=a.LogLevelEnum.DEBUG&&this._log(console.log,e,t);},e.prototype.info=function(e){for(var t=[],r=1;r<arguments.length;r++)t[r-1]=arguments[r];this.logLevel<=a.LogLevelEnum.INFO&&this._log(console.info,e,t);},e.prototype.warn=function(e){for(var t=[],r=1;r<arguments.length;r++)t[r-1]=arguments[r];this.logLevel<=a.LogLevelEnum.WARN&&this._log(console.warn,e,t);},e.prototype.error=function(e){for(var t=[],r=1;r<arguments.length;r++)t[r-1]=arguments[r];this.logLevel<=a.LogLevelEnum.ERROR&&this._log(console.error,e,t);},i([n(0,a.IOptionsService)],e)}();t.LogService=l;},7302:function(e,t,r){var i=this&&this.__assign||function(){return i=Object.assign||function(e){for(var t,r=1,i=arguments.length;r<i;r++)for(var n in t=arguments[r])Object.prototype.hasOwnProperty.call(t,n)&&(e[n]=t[n]);return e},i.apply(this,arguments)};Object.defineProperty(t,"__esModule",{value:!0}),t.OptionsService=t.DEFAULT_OPTIONS=t.DEFAULT_BELL_SOUND=void 0;var n=r(8460),o=r(6114);t.DEFAULT_BELL_SOUND="data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjMyLjEwNAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",t.DEFAULT_OPTIONS={cols:80,rows:24,cursorBlink:!1,cursorStyle:"block",cursorWidth:1,customGlyphs:!0,bellSound:t.DEFAULT_BELL_SOUND,bellStyle:"none",drawBoldTextInBrightColors:!0,fastScrollModifier:"alt",fastScrollSensitivity:5,fontFamily:"courier-new, courier, monospace",fontSize:15,fontWeight:"normal",fontWeightBold:"bold",lineHeight:1,linkTooltipHoverDuration:500,letterSpacing:0,logLevel:"info",scrollback:1e3,scrollSensitivity:1,screenReaderMode:!1,macOptionIsMeta:!1,macOptionClickForcesSelection:!1,minimumContrastRatio:1,disableStdin:!1,allowProposedApi:!0,allowTransparency:!1,tabStopWidth:8,theme:{},rightClickSelectsWord:o.isMac,rendererType:"canvas",windowOptions:{},windowsMode:!1,wordSeparator:" ()[]{}',\"`",altClickMovesCursor:!0,convertEol:!1,termName:"xterm",cancelEvents:!1,overviewRulerWidth:void 0};var s=["normal","bold","100","200","300","400","500","600","700","800","900"],a=function(){function e(e){this._onOptionChange=new n.EventEmitter;var r=i({},t.DEFAULT_OPTIONS);for(var o in e)if(o in r)try{var s=e[o];r[o]=this._sanitizeAndValidateOption(o,s);}catch(e){console.error(e);}this.rawOptions=r,this.options=i({},r),this._setupOptions();}return Object.defineProperty(e.prototype,"onOptionChange",{get:function(){return this._onOptionChange.event},enumerable:!1,configurable:!0}),e.prototype._setupOptions=function(){var e=this,r=function(r){if(!(r in t.DEFAULT_OPTIONS))throw new Error('No option with key "'+r+'"');return e.rawOptions[r]},i=function(r,i){if(!(r in t.DEFAULT_OPTIONS))throw new Error('No option with key "'+r+'"');i=e._sanitizeAndValidateOption(r,i),e.rawOptions[r]!==i&&(e.rawOptions[r]=i,e._onOptionChange.fire(r));};for(var n in this.rawOptions){var o={get:r.bind(this,n),set:i.bind(this,n)};Object.defineProperty(this.options,n,o);}},e.prototype.setOption=function(e,t){this.options[e]=t;},e.prototype._sanitizeAndValidateOption=function(e,r){switch(e){case"bellStyle":case"cursorStyle":case"rendererType":case"wordSeparator":r||(r=t.DEFAULT_OPTIONS[e]);break;case"fontWeight":case"fontWeightBold":if("number"==typeof r&&1<=r&&r<=1e3)break;r=s.includes(r)?r:t.DEFAULT_OPTIONS[e];break;case"cursorWidth":r=Math.floor(r);case"lineHeight":case"tabStopWidth":if(r<1)throw new Error(e+" cannot be less than 1, value: "+r);break;case"minimumContrastRatio":r=Math.max(1,Math.min(21,Math.round(10*r)/10));break;case"scrollback":if((r=Math.min(r,4294967295))<0)throw new Error(e+" cannot be less than 0, value: "+r);break;case"fastScrollSensitivity":case"scrollSensitivity":if(r<=0)throw new Error(e+" cannot be less than or equal to 0, value: "+r);case"rows":case"cols":if(!r&&0!==r)throw new Error(e+" must be numeric, value: "+r)}return r},e.prototype.getOption=function(e){return this.options[e]},e}();t.OptionsService=a;},8343:(e,t)=>{function r(e,t,r){t.di$target===t?t.di$dependencies.push({id:e,index:r}):(t.di$dependencies=[{id:e,index:r}],t.di$target=t);}Object.defineProperty(t,"__esModule",{value:!0}),t.createDecorator=t.getServiceDependencies=t.serviceRegistry=void 0,t.serviceRegistry=new Map,t.getServiceDependencies=function(e){return e.di$dependencies||[]},t.createDecorator=function(e){if(t.serviceRegistry.has(e))return t.serviceRegistry.get(e);var i=function(e,t,n){if(3!==arguments.length)throw new Error("@IServiceName-decorator can only be used to decorate a parameter");r(i,e,n);};return i.toString=function(){return e},t.serviceRegistry.set(e,i),i};},2585:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.IDecorationService=t.IUnicodeService=t.IOptionsService=t.ILogService=t.LogLevelEnum=t.IInstantiationService=t.IDirtyRowService=t.ICharsetService=t.ICoreService=t.ICoreMouseService=t.IBufferService=void 0;var i,n=r(8343);t.IBufferService=(0, n.createDecorator)("BufferService"),t.ICoreMouseService=(0, n.createDecorator)("CoreMouseService"),t.ICoreService=(0, n.createDecorator)("CoreService"),t.ICharsetService=(0, n.createDecorator)("CharsetService"),t.IDirtyRowService=(0, n.createDecorator)("DirtyRowService"),t.IInstantiationService=(0, n.createDecorator)("InstantiationService"),(i=t.LogLevelEnum||(t.LogLevelEnum={}))[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.OFF=4]="OFF",t.ILogService=(0, n.createDecorator)("LogService"),t.IOptionsService=(0, n.createDecorator)("OptionsService"),t.IUnicodeService=(0, n.createDecorator)("UnicodeService"),t.IDecorationService=(0, n.createDecorator)("DecorationService");},1480:(e,t,r)=>{Object.defineProperty(t,"__esModule",{value:!0}),t.UnicodeService=void 0;var i=r(8460),n=r(225),o=function(){function e(){this._providers=Object.create(null),this._active="",this._onChange=new i.EventEmitter;var e=new n.UnicodeV6;this.register(e),this._active=e.version,this._activeProvider=e;}return Object.defineProperty(e.prototype,"onChange",{get:function(){return this._onChange.event},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"versions",{get:function(){return Object.keys(this._providers)},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"activeVersion",{get:function(){return this._active},set:function(e){if(!this._providers[e])throw new Error('unknown Unicode version "'+e+'"');this._active=e,this._activeProvider=this._providers[e],this._onChange.fire(e);},enumerable:!1,configurable:!0}),e.prototype.register=function(e){this._providers[e.version]=e;},e.prototype.wcwidth=function(e){return this._activeProvider.wcwidth(e)},e.prototype.getStringCellWidth=function(e){for(var t=0,r=e.length,i=0;i<r;++i){var n=e.charCodeAt(i);if(55296<=n&&n<=56319){if(++i>=r)return t+this.wcwidth(n);var o=e.charCodeAt(i);56320<=o&&o<=57343?n=1024*(n-55296)+o-56320+65536:t+=this.wcwidth(o);}t+=this.wcwidth(n);}return t},e}();t.UnicodeService=o;}},t={};return function r(i){var n=t[i];if(void 0!==n)return n.exports;var o=t[i]={exports:{}};return e[i].call(o.exports,o,o.exports,r),o.exports}(4389)})()}));

    });

    var xterm$1 = unwrapExports(xterm);

    var xterm$2 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        'default': xterm$1,
        __moduleExports: xterm
    });

    var xtermAddonFit = createCommonjsModule(function (module, exports) {
    !function(e,t){module.exports=t();}(window,(function(){return function(e){var t={};function r(n){if(t[n])return t[n].exports;var o=t[n]={i:n,l:!1,exports:{}};return e[n].call(o.exports,o,o.exports,r),o.l=!0,o.exports}return r.m=e,r.c=t,r.d=function(e,t,n){r.o(e,t)||Object.defineProperty(e,t,{enumerable:!0,get:n});},r.r=function(e){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0});},r.t=function(e,t){if(1&t&&(e=r(e)),8&t)return e;if(4&t&&"object"==typeof e&&e&&e.__esModule)return e;var n=Object.create(null);if(r.r(n),Object.defineProperty(n,"default",{enumerable:!0,value:e}),2&t&&"string"!=typeof e)for(var o in e)r.d(n,o,function(t){return e[t]}.bind(null,o));return n},r.n=function(e){var t=e&&e.__esModule?function(){return e.default}:function(){return e};return r.d(t,"a",t),t},r.o=function(e,t){return Object.prototype.hasOwnProperty.call(e,t)},r.p="",r(r.s=0)}([function(e,t,r){Object.defineProperty(t,"__esModule",{value:!0}),t.FitAddon=void 0;var n=function(){function e(){}return e.prototype.activate=function(e){this._terminal=e;},e.prototype.dispose=function(){},e.prototype.fit=function(){var e=this.proposeDimensions();if(e&&this._terminal){var t=this._terminal._core;this._terminal.rows===e.rows&&this._terminal.cols===e.cols||(t._renderService.clear(),this._terminal.resize(e.cols,e.rows));}},e.prototype.proposeDimensions=function(){if(this._terminal&&this._terminal.element&&this._terminal.element.parentElement){var e=this._terminal._core,t=window.getComputedStyle(this._terminal.element.parentElement),r=parseInt(t.getPropertyValue("height")),n=Math.max(0,parseInt(t.getPropertyValue("width"))),o=window.getComputedStyle(this._terminal.element),i=r-(parseInt(o.getPropertyValue("padding-top"))+parseInt(o.getPropertyValue("padding-bottom"))),a=n-(parseInt(o.getPropertyValue("padding-right"))+parseInt(o.getPropertyValue("padding-left")))-e.viewport.scrollBarWidth;return {cols:Math.max(2,Math.floor(a/e._renderService.dimensions.actualCellWidth)),rows:Math.max(1,Math.floor(i/e._renderService.dimensions.actualCellHeight))}}},e}();t.FitAddon=n;}])}));

    });

    unwrapExports(xtermAddonFit);
    var xtermAddonFit_1 = xtermAddonFit.FitAddon;

    var smoothie = createCommonjsModule(function (module, exports) {
    (function(exports) {

    /**
     * @license
     * MIT License:
     *
     * Copyright (c) 2010-2013, Joe Walnes
     *               2013-2018, Drew Noakes
     *
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included in
     * all copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
     * THE SOFTWARE.
     */

    /**
     * Smoothie Charts - http://smoothiecharts.org/
     * (c) 2010-2013, Joe Walnes
     *     2013-2018, Drew Noakes
     *
     * v1.0: Main charting library, by Joe Walnes
     * v1.1: Auto scaling of axis, by Neil Dunn
     * v1.2: fps (frames per second) option, by Mathias Petterson
     * v1.3: Fix for divide by zero, by Paul Nikitochkin
     * v1.4: Set minimum, top-scale padding, remove timeseries, add optional timer to reset bounds, by Kelley Reynolds
     * v1.5: Set default frames per second to 50... smoother.
     *       .start(), .stop() methods for conserving CPU, by Dmitry Vyal
     *       options.interpolation = 'bezier' or 'line', by Dmitry Vyal
     *       options.maxValue to fix scale, by Dmitry Vyal
     * v1.6: minValue/maxValue will always get converted to floats, by Przemek Matylla
     * v1.7: options.grid.fillStyle may be a transparent color, by Dmitry A. Shashkin
     *       Smooth rescaling, by Kostas Michalopoulos
     * v1.8: Set max length to customize number of live points in the dataset with options.maxDataSetLength, by Krishna Narni
     * v1.9: Display timestamps along the bottom, by Nick and Stev-io
     *       (https://groups.google.com/forum/?fromgroups#!topic/smoothie-charts/-Ywse8FCpKI%5B1-25%5D)
     *       Refactored by Krishna Narni, to support timestamp formatting function
     * v1.10: Switch to requestAnimationFrame, removed the now obsoleted options.fps, by Gergely Imreh
     * v1.11: options.grid.sharpLines option added, by @drewnoakes
     *        Addressed warning seen in Firefox when seriesOption.fillStyle undefined, by @drewnoakes
     * v1.12: Support for horizontalLines added, by @drewnoakes
     *        Support for yRangeFunction callback added, by @drewnoakes
     * v1.13: Fixed typo (#32), by @alnikitich
     * v1.14: Timer cleared when last TimeSeries removed (#23), by @davidgaleano
     *        Fixed diagonal line on chart at start/end of data stream, by @drewnoakes
     * v1.15: Support for npm package (#18), by @dominictarr
     *        Fixed broken removeTimeSeries function (#24) by @davidgaleano
     *        Minor performance and tidying, by @drewnoakes
     * v1.16: Bug fix introduced in v1.14 relating to timer creation/clearance (#23), by @drewnoakes
     *        TimeSeries.append now deals with out-of-order timestamps, and can merge duplicates, by @zacwitte (#12)
     *        Documentation and some local variable renaming for clarity, by @drewnoakes
     * v1.17: Allow control over font size (#10), by @drewnoakes
     *        Timestamp text won't overlap, by @drewnoakes
     * v1.18: Allow control of max/min label precision, by @drewnoakes
     *        Added 'borderVisible' chart option, by @drewnoakes
     *        Allow drawing series with fill but no stroke (line), by @drewnoakes
     * v1.19: Avoid unnecessary repaints, and fixed flicker in old browsers having multiple charts in document (#40), by @asbai
     * v1.20: Add SmoothieChart.getTimeSeriesOptions and SmoothieChart.bringToFront functions, by @drewnoakes
     * v1.21: Add 'step' interpolation mode, by @drewnoakes
     * v1.22: Add support for different pixel ratios. Also add optional y limit formatters, by @copacetic
     * v1.23: Fix bug introduced in v1.22 (#44), by @drewnoakes
     * v1.24: Fix bug introduced in v1.23, re-adding parseFloat to y-axis formatter defaults, by @siggy_sf
     * v1.25: Fix bug seen when adding a data point to TimeSeries which is older than the current data, by @Nking92
     *        Draw time labels on top of series, by @comolosabia
     *        Add TimeSeries.clear function, by @drewnoakes
     * v1.26: Add support for resizing on high device pixel ratio screens, by @copacetic
     * v1.27: Fix bug introduced in v1.26 for non whole number devicePixelRatio values, by @zmbush
     * v1.28: Add 'minValueScale' option, by @megawac
     *        Fix 'labelPos' for different size of 'minValueString' 'maxValueString', by @henryn
     * v1.29: Support responsive sizing, by @drewnoakes
     * v1.29.1: Include types in package, and make property optional, by @TrentHouliston
     * v1.30: Fix inverted logic in devicePixelRatio support, by @scanlime
     * v1.31: Support tooltips, by @Sly1024 and @drewnoakes
     * v1.32: Support frame rate limit, by @dpuyosa
     * v1.33: Use Date static method instead of instance, by @nnnoel
     *        Fix bug with tooltips when multiple charts on a page, by @jpmbiz70
     * v1.34: Add disabled option to TimeSeries, by @TechGuard (#91)
     *        Add nonRealtimeData option, by @annazhelt (#92, #93)
     *        Add showIntermediateLabels option, by @annazhelt (#94)
     *        Add displayDataFromPercentile option, by @annazhelt (#95)
     *        Fix bug when hiding tooltip element, by @ralphwetzel (#96)
     *        Support intermediate y-axis labels, by @beikeland (#99)
     * v1.35: Fix issue with responsive mode at high DPI, by @drewnoakes (#101)
     * v1.36: Add tooltipLabel to ITimeSeriesPresentationOptions.
     *        If tooltipLabel is present, tooltipLabel displays inside tooltip
     *        next to value, by @jackdesert (#102)
     *        Fix bug rendering issue in series fill when using scroll backwards, by @olssonfredrik
     *        Add title option, by @mesca
     *        Fix data drop stoppage by rejecting NaNs in append(), by @timdrysdale
     *        Allow setting interpolation per time series, by @WofWca (#123)
     *        Fix chart constantly jumping in 1-2 pixel steps, by @WofWca (#131)
     *        Fix a memory leak appearing when some `timeSeries.disabled === true`, by @WofWca (#132)
     *        Fix: make all lines sharp, remove the `grid.sharpLines` option by @WofWca (#134)
     *        Improve performance, by @WofWca (#135)
     *        Fix `this.delay` not being respected with `nonRealtimeData: true`, by @WofWca (#137)
     *        Fix series fill & stroke being inconsistent for last data time < render time, by @WofWca (#138)
     * v1.36.1: Fix a potential XSS when `tooltipLabel` or `strokeStyle` are controlled by users, by @WofWca
     */

      // Date.now polyfill
      Date.now = Date.now || function() { return new Date().getTime(); };

      var Util = {
        extend: function() {
          arguments[0] = arguments[0] || {};
          for (var i = 1; i < arguments.length; i++)
          {
            for (var key in arguments[i])
            {
              if (arguments[i].hasOwnProperty(key))
              {
                if (typeof(arguments[i][key]) === 'object') {
                  if (arguments[i][key] instanceof Array) {
                    arguments[0][key] = arguments[i][key];
                  } else {
                    arguments[0][key] = Util.extend(arguments[0][key], arguments[i][key]);
                  }
                } else {
                  arguments[0][key] = arguments[i][key];
                }
              }
            }
          }
          return arguments[0];
        },
        binarySearch: function(data, value) {
          var low = 0,
              high = data.length;
          while (low < high) {
            var mid = (low + high) >> 1;
            if (value < data[mid][0])
              high = mid;
            else
              low = mid + 1;
          }
          return low;
        },
        // So lines (especially vertical and horizontal) look a) consistent along their length and b) sharp.
        pixelSnap: function(position, lineWidth) {
          if (lineWidth % 2 === 0) {
            // Closest pixel edge.
            return Math.round(position);
          } else {
            // Closest pixel center.
            return Math.floor(position) + 0.5;
          }
        },
      };

      /**
       * Initialises a new <code>TimeSeries</code> with optional data options.
       *
       * Options are of the form (defaults shown):
       *
       * <pre>
       * {
       *   resetBounds: true,        // enables/disables automatic scaling of the y-axis
       *   resetBoundsInterval: 3000 // the period between scaling calculations, in millis
       * }
       * </pre>
       *
       * Presentation options for TimeSeries are specified as an argument to <code>SmoothieChart.addTimeSeries</code>.
       *
       * @constructor
       */
      function TimeSeries(options) {
        this.options = Util.extend({}, TimeSeries.defaultOptions, options);
        this.disabled = false;
        this.clear();
      }

      TimeSeries.defaultOptions = {
        resetBoundsInterval: 3000,
        resetBounds: true
      };

      /**
       * Clears all data and state from this TimeSeries object.
       */
      TimeSeries.prototype.clear = function() {
        this.data = [];
        this.maxValue = Number.NaN; // The maximum value ever seen in this TimeSeries.
        this.minValue = Number.NaN; // The minimum value ever seen in this TimeSeries.
      };

      /**
       * Recalculate the min/max values for this <code>TimeSeries</code> object.
       *
       * This causes the graph to scale itself in the y-axis.
       */
      TimeSeries.prototype.resetBounds = function() {
        if (this.data.length) {
          // Walk through all data points, finding the min/max value
          this.maxValue = this.data[0][1];
          this.minValue = this.data[0][1];
          for (var i = 1; i < this.data.length; i++) {
            var value = this.data[i][1];
            if (value > this.maxValue) {
              this.maxValue = value;
            }
            if (value < this.minValue) {
              this.minValue = value;
            }
          }
        } else {
          // No data exists, so set min/max to NaN
          this.maxValue = Number.NaN;
          this.minValue = Number.NaN;
        }
      };

      /**
       * Adds a new data point to the <code>TimeSeries</code>, preserving chronological order.
       *
       * @param timestamp the position, in time, of this data point
       * @param value the value of this data point
       * @param sumRepeatedTimeStampValues if <code>timestamp</code> has an exact match in the series, this flag controls
       * whether it is replaced, or the values summed (defaults to false.)
       */
      TimeSeries.prototype.append = function(timestamp, value, sumRepeatedTimeStampValues) {
    	// Reject NaN
    	if (isNaN(timestamp) || isNaN(value)){
    		return
    	}  

        var lastI = this.data.length - 1;
        if (lastI >= 0) {
          // Rewind until we find the place for the new data
          var i = lastI;
          while (true) {
            var iThData = this.data[i];
            if (timestamp >= iThData[0]) {
              if (timestamp === iThData[0]) {
                // Update existing values in the array
                if (sumRepeatedTimeStampValues) {
                  // Sum this value into the existing 'bucket'
                  iThData[1] += value;
                  value = iThData[1];
                } else {
                  // Replace the previous value
                  iThData[1] = value;
                }
              } else {
                // Splice into the correct position to keep timestamps in order
                this.data.splice(i + 1, 0, [timestamp, value]);
              }

              break;
            }

            i--;
            if (i < 0) {
              // This new item is the oldest data
              this.data.splice(0, 0, [timestamp, value]);

              break;
            }
          }
        } else {
          // It's the first element
          this.data.push([timestamp, value]);
        }

        this.maxValue = isNaN(this.maxValue) ? value : Math.max(this.maxValue, value);
        this.minValue = isNaN(this.minValue) ? value : Math.min(this.minValue, value);
      };

      TimeSeries.prototype.dropOldData = function(oldestValidTime, maxDataSetLength) {
        // We must always keep one expired data point as we need this to draw the
        // line that comes into the chart from the left, but any points prior to that can be removed.
        var removeCount = 0;
        while (this.data.length - removeCount >= maxDataSetLength && this.data[removeCount + 1][0] < oldestValidTime) {
          removeCount++;
        }
        if (removeCount !== 0) {
          this.data.splice(0, removeCount);
        }
      };

      /**
       * Initialises a new <code>SmoothieChart</code>.
       *
       * Options are optional, and should be of the form below. Just specify the values you
       * need and the rest will be given sensible defaults as shown:
       *
       * <pre>
       * {
       *   minValue: undefined,                      // specify to clamp the lower y-axis to a given value
       *   maxValue: undefined,                      // specify to clamp the upper y-axis to a given value
       *   maxValueScale: 1,                         // allows proportional padding to be added above the chart. for 10% padding, specify 1.1.
       *   minValueScale: 1,                         // allows proportional padding to be added below the chart. for 10% padding, specify 1.1.
       *   yRangeFunction: undefined,                // function({min: , max: }) { return {min: , max: }; }
       *   scaleSmoothing: 0.125,                    // controls the rate at which y-value zoom animation occurs
       *   millisPerPixel: 20,                       // sets the speed at which the chart pans by
       *   enableDpiScaling: true,                   // support rendering at different DPI depending on the device
       *   yMinFormatter: function(min, precision) { // callback function that formats the min y value label
       *     return parseFloat(min).toFixed(precision);
       *   },
       *   yMaxFormatter: function(max, precision) { // callback function that formats the max y value label
       *     return parseFloat(max).toFixed(precision);
       *   },
       *   yIntermediateFormatter: function(intermediate, precision) { // callback function that formats the intermediate y value labels
       *     return parseFloat(intermediate).toFixed(precision);
       *   },
       *   maxDataSetLength: 2,
       *   interpolation: 'bezier'                   // one of 'bezier', 'linear', or 'step'
       *   timestampFormatter: null,                 // optional function to format time stamps for bottom of chart
       *                                             // you may use SmoothieChart.timeFormatter, or your own: function(date) { return ''; }
       *   scrollBackwards: false,                   // reverse the scroll direction of the chart
       *   horizontalLines: [],                      // [ { value: 0, color: '#ffffff', lineWidth: 1 } ]
       *   grid:
       *   {
       *     fillStyle: '#000000',                   // the background colour of the chart
       *     lineWidth: 1,                           // the pixel width of grid lines
       *     strokeStyle: '#777777',                 // colour of grid lines
       *     millisPerLine: 1000,                    // distance between vertical grid lines
       *     verticalSections: 2,                    // number of vertical sections marked out by horizontal grid lines
       *     borderVisible: true                     // whether the grid lines trace the border of the chart or not
       *   },
       *   labels
       *   {
       *     disabled: false,                        // enables/disables labels showing the min/max values
       *     fillStyle: '#ffffff',                   // colour for text of labels,
       *     fontSize: 15,
       *     fontFamily: 'sans-serif',
       *     precision: 2,
       *     showIntermediateLabels: false,          // shows intermediate labels between min and max values along y axis
       *     intermediateLabelSameAxis: true,
       *   },
       *   title
       *   {
       *     text: '',                               // the text to display on the left side of the chart
       *     fillStyle: '#ffffff',                   // colour for text
       *     fontSize: 15,
       *     fontFamily: 'sans-serif',
       *     verticalAlign: 'middle'                 // one of 'top', 'middle', or 'bottom'
       *   },
       *   tooltip: false                            // show tooltip when mouse is over the chart
       *   tooltipLine: {                            // properties for a vertical line at the cursor position
       *     lineWidth: 1,
       *     strokeStyle: '#BBBBBB'
       *   },
       *   tooltipFormatter: SmoothieChart.tooltipFormatter, // formatter function for tooltip text
       *   nonRealtimeData: false,                   // use time of latest data as current time
       *   displayDataFromPercentile: 1,             // display not latest data, but data from the given percentile
       *                                             // useful when trying to see old data saved by setting a high value for maxDataSetLength
       *                                             // should be a value between 0 and 1
       *   responsive: false,                        // whether the chart should adapt to the size of the canvas
       *   limitFPS: 0                               // maximum frame rate the chart will render at, in FPS (zero means no limit)
       * }
       * </pre>
       *
       * @constructor
       */
      function SmoothieChart(options) {
        this.options = Util.extend({}, SmoothieChart.defaultChartOptions, options);
        this.seriesSet = [];
        this.currentValueRange = 1;
        this.currentVisMinValue = 0;
        this.lastRenderTimeMillis = 0;
        this.lastChartTimestamp = 0;

        this.mousemove = this.mousemove.bind(this);
        this.mouseout = this.mouseout.bind(this);
      }

      /** Formats the HTML string content of the tooltip. */
      SmoothieChart.tooltipFormatter = function (timestamp, data) {
          var timestampFormatter = this.options.timestampFormatter || SmoothieChart.timeFormatter,
              // A dummy element to hold children. Maybe there's a better way.
              elements = document.createElement('div'),
              label;
          elements.appendChild(document.createTextNode(
            timestampFormatter(new Date(timestamp))
          ));

          for (var i = 0; i < data.length; ++i) {
            label = data[i].series.options.tooltipLabel || '';
            if (label !== ''){
                label = label + ' ';
            }
            var dataEl = document.createElement('span');
            dataEl.style.color = data[i].series.options.strokeStyle;
            dataEl.appendChild(document.createTextNode(
              label + this.options.yMaxFormatter(data[i].value, this.options.labels.precision)
            ));
            elements.appendChild(document.createElement('br'));
            elements.appendChild(dataEl);
          }

          return elements.innerHTML;
      };

      SmoothieChart.defaultChartOptions = {
        millisPerPixel: 20,
        enableDpiScaling: true,
        yMinFormatter: function(min, precision) {
          return parseFloat(min).toFixed(precision);
        },
        yMaxFormatter: function(max, precision) {
          return parseFloat(max).toFixed(precision);
        },
        yIntermediateFormatter: function(intermediate, precision) {
          return parseFloat(intermediate).toFixed(precision);
        },
        maxValueScale: 1,
        minValueScale: 1,
        interpolation: 'bezier',
        scaleSmoothing: 0.125,
        maxDataSetLength: 2,
        scrollBackwards: false,
        displayDataFromPercentile: 1,
        grid: {
          fillStyle: '#000000',
          strokeStyle: '#777777',
          lineWidth: 2,
          millisPerLine: 1000,
          verticalSections: 2,
          borderVisible: true
        },
        labels: {
          fillStyle: '#ffffff',
          disabled: false,
          fontSize: 10,
          fontFamily: 'monospace',
          precision: 2,
          showIntermediateLabels: false,
          intermediateLabelSameAxis: true,
        },
        title: {
          text: '',
          fillStyle: '#ffffff',
          fontSize: 15,
          fontFamily: 'monospace',
          verticalAlign: 'middle'
        },
        horizontalLines: [],
        tooltip: false,
        tooltipLine: {
          lineWidth: 1,
          strokeStyle: '#BBBBBB'
        },
        tooltipFormatter: SmoothieChart.tooltipFormatter,
        nonRealtimeData: false,
        responsive: false,
        limitFPS: 0
      };

      // Based on http://inspirit.github.com/jsfeat/js/compatibility.js
      SmoothieChart.AnimateCompatibility = (function() {
        var requestAnimationFrame = function(callback, element) {
              var requestAnimationFrame =
                window.requestAnimationFrame        ||
                window.webkitRequestAnimationFrame  ||
                window.mozRequestAnimationFrame     ||
                window.oRequestAnimationFrame       ||
                window.msRequestAnimationFrame      ||
                function(callback) {
                  return window.setTimeout(function() {
                    callback(Date.now());
                  }, 16);
                };
              return requestAnimationFrame.call(window, callback, element);
            },
            cancelAnimationFrame = function(id) {
              var cancelAnimationFrame =
                window.cancelAnimationFrame ||
                function(id) {
                  clearTimeout(id);
                };
              return cancelAnimationFrame.call(window, id);
            };

        return {
          requestAnimationFrame: requestAnimationFrame,
          cancelAnimationFrame: cancelAnimationFrame
        };
      })();

      SmoothieChart.defaultSeriesPresentationOptions = {
        lineWidth: 1,
        strokeStyle: '#ffffff'
      };

      /**
       * Adds a <code>TimeSeries</code> to this chart, with optional presentation options.
       *
       * Presentation options should be of the form (defaults shown):
       *
       * <pre>
       * {
       *   lineWidth: 1,
       *   strokeStyle: '#ffffff',
       *   fillStyle: undefined,
       *   interpolation: undefined;
       *   tooltipLabel: undefined
       * }
       * </pre>
       */
      SmoothieChart.prototype.addTimeSeries = function(timeSeries, options) {
        this.seriesSet.push({timeSeries: timeSeries, options: Util.extend({}, SmoothieChart.defaultSeriesPresentationOptions, options)});
        if (timeSeries.options.resetBounds && timeSeries.options.resetBoundsInterval > 0) {
          timeSeries.resetBoundsTimerId = setInterval(
            function() {
              timeSeries.resetBounds();
            },
            timeSeries.options.resetBoundsInterval
          );
        }
      };

      /**
       * Removes the specified <code>TimeSeries</code> from the chart.
       */
      SmoothieChart.prototype.removeTimeSeries = function(timeSeries) {
        // Find the correct timeseries to remove, and remove it
        var numSeries = this.seriesSet.length;
        for (var i = 0; i < numSeries; i++) {
          if (this.seriesSet[i].timeSeries === timeSeries) {
            this.seriesSet.splice(i, 1);
            break;
          }
        }
        // If a timer was operating for that timeseries, remove it
        if (timeSeries.resetBoundsTimerId) {
          // Stop resetting the bounds, if we were
          clearInterval(timeSeries.resetBoundsTimerId);
        }
      };

      /**
       * Gets render options for the specified <code>TimeSeries</code>.
       *
       * As you may use a single <code>TimeSeries</code> in multiple charts with different formatting in each usage,
       * these settings are stored in the chart.
       */
      SmoothieChart.prototype.getTimeSeriesOptions = function(timeSeries) {
        // Find the correct timeseries to remove, and remove it
        var numSeries = this.seriesSet.length;
        for (var i = 0; i < numSeries; i++) {
          if (this.seriesSet[i].timeSeries === timeSeries) {
            return this.seriesSet[i].options;
          }
        }
      };

      /**
       * Brings the specified <code>TimeSeries</code> to the top of the chart. It will be rendered last.
       */
      SmoothieChart.prototype.bringToFront = function(timeSeries) {
        // Find the correct timeseries to remove, and remove it
        var numSeries = this.seriesSet.length;
        for (var i = 0; i < numSeries; i++) {
          if (this.seriesSet[i].timeSeries === timeSeries) {
            var set = this.seriesSet.splice(i, 1);
            this.seriesSet.push(set[0]);
            break;
          }
        }
      };

      /**
       * Instructs the <code>SmoothieChart</code> to start rendering to the provided canvas, with specified delay.
       *
       * @param canvas the target canvas element
       * @param delayMillis an amount of time to wait before a data point is shown. This can prevent the end of the series
       * from appearing on screen, with new values flashing into view, at the expense of some latency.
       */
      SmoothieChart.prototype.streamTo = function(canvas, delayMillis) {
        this.canvas = canvas;

        this.clientWidth = parseInt(this.canvas.getAttribute('width'));
        this.clientHeight = parseInt(this.canvas.getAttribute('height'));

        this.delay = delayMillis;
        this.start();
      };

      SmoothieChart.prototype.getTooltipEl = function () {
        // Create the tool tip element lazily
        if (!this.tooltipEl) {
          this.tooltipEl = document.createElement('div');
          this.tooltipEl.className = 'smoothie-chart-tooltip';
          this.tooltipEl.style.pointerEvents = 'none';
          this.tooltipEl.style.position = 'absolute';
          this.tooltipEl.style.display = 'none';
          document.body.appendChild(this.tooltipEl);
        }
        return this.tooltipEl;
      };

      SmoothieChart.prototype.updateTooltip = function () {
        if(!this.options.tooltip){
         return; 
        }
        var el = this.getTooltipEl();

        if (!this.mouseover || !this.options.tooltip) {
          el.style.display = 'none';
          return;
        }

        var time = this.lastChartTimestamp;

        // x pixel to time
        var t = this.options.scrollBackwards
          ? time - this.mouseX * this.options.millisPerPixel
          : time - (this.clientWidth - this.mouseX) * this.options.millisPerPixel;

        var data = [];

         // For each data set...
        for (var d = 0; d < this.seriesSet.length; d++) {
          var timeSeries = this.seriesSet[d].timeSeries;
          if (timeSeries.disabled) {
              continue;
          }

          // find datapoint closest to time 't'
          var closeIdx = Util.binarySearch(timeSeries.data, t);
          if (closeIdx > 0 && closeIdx < timeSeries.data.length) {
            data.push({ series: this.seriesSet[d], index: closeIdx, value: timeSeries.data[closeIdx][1] });
          }
        }

        if (data.length) {
          // TODO make `tooltipFormatter` return element(s) instead of an HTML string so it's harder for users
          // to introduce an XSS. This would be a breaking change.
          el.innerHTML = this.options.tooltipFormatter.call(this, t, data);
          el.style.display = 'block';
        } else {
          el.style.display = 'none';
        }
      };

      SmoothieChart.prototype.mousemove = function (evt) {
        this.mouseover = true;
        this.mouseX = evt.offsetX;
        this.mouseY = evt.offsetY;
        this.mousePageX = evt.pageX;
        this.mousePageY = evt.pageY;
        if(!this.options.tooltip){
         return; 
        }
        var el = this.getTooltipEl();
        el.style.top = Math.round(this.mousePageY) + 'px';
        el.style.left = Math.round(this.mousePageX) + 'px';
        this.updateTooltip();
      };

      SmoothieChart.prototype.mouseout = function () {
        this.mouseover = false;
        this.mouseX = this.mouseY = -1;
        if (this.tooltipEl)
          this.tooltipEl.style.display = 'none';
      };

      /**
       * Make sure the canvas has the optimal resolution for the device's pixel ratio.
       */
      SmoothieChart.prototype.resize = function () {
        var dpr = !this.options.enableDpiScaling || !window ? 1 : window.devicePixelRatio,
            width, height;
        if (this.options.responsive) {
          // Newer behaviour: Use the canvas's size in the layout, and set the internal
          // resolution according to that size and the device pixel ratio (eg: high DPI)
          width = this.canvas.offsetWidth;
          height = this.canvas.offsetHeight;

          if (width !== this.lastWidth) {
            this.lastWidth = width;
            this.canvas.setAttribute('width', (Math.floor(width * dpr)).toString());
            this.canvas.getContext('2d').scale(dpr, dpr);
          }
          if (height !== this.lastHeight) {
            this.lastHeight = height;
            this.canvas.setAttribute('height', (Math.floor(height * dpr)).toString());
            this.canvas.getContext('2d').scale(dpr, dpr);
          }

          this.clientWidth = width;
          this.clientHeight = height;
        } else {
          width = parseInt(this.canvas.getAttribute('width'));
          height = parseInt(this.canvas.getAttribute('height'));

          if (dpr !== 1) {
            // Older behaviour: use the canvas's inner dimensions and scale the element's size
            // according to that size and the device pixel ratio (eg: high DPI)

            if (Math.floor(this.clientWidth * dpr) !== width) {
              this.canvas.setAttribute('width', (Math.floor(width * dpr)).toString());
              this.canvas.style.width = width + 'px';
              this.clientWidth = width;
              this.canvas.getContext('2d').scale(dpr, dpr);
            }

            if (Math.floor(this.clientHeight * dpr) !== height) {
              this.canvas.setAttribute('height', (Math.floor(height * dpr)).toString());
              this.canvas.style.height = height + 'px';
              this.clientHeight = height;
              this.canvas.getContext('2d').scale(dpr, dpr);
            }
          } else {
            this.clientWidth = width;
            this.clientHeight = height;
          }
        }
      };

      /**
       * Starts the animation of this chart.
       */
      SmoothieChart.prototype.start = function() {
        if (this.frame) {
          // We're already running, so just return
          return;
        }

        this.canvas.addEventListener('mousemove', this.mousemove);
        this.canvas.addEventListener('mouseout', this.mouseout);

        // Renders a frame, and queues the next frame for later rendering
        var animate = function() {
          this.frame = SmoothieChart.AnimateCompatibility.requestAnimationFrame(function() {
            if(this.options.nonRealtimeData){
               var dateZero = new Date(0);
               // find the data point with the latest timestamp
               var maxTimeStamp = this.seriesSet.reduce(function(max, series){
                 var dataSet = series.timeSeries.data;
                 var indexToCheck = Math.round(this.options.displayDataFromPercentile * dataSet.length) - 1;
                 indexToCheck = indexToCheck >= 0 ? indexToCheck : 0;
                 indexToCheck = indexToCheck <= dataSet.length -1 ? indexToCheck : dataSet.length -1;
                 if(dataSet && dataSet.length > 0)
                 {
                  // timestamp corresponds to element 0 of the data point
                  var lastDataTimeStamp = dataSet[indexToCheck][0];
                  max = max > lastDataTimeStamp ? max : lastDataTimeStamp;
                 }
                 return max;
              }.bind(this), dateZero);
              // use the max timestamp as current time
              this.render(this.canvas, maxTimeStamp > dateZero ? maxTimeStamp : null);
            } else {
              this.render();
            }
            animate();
          }.bind(this));
        }.bind(this);

        animate();
      };

      /**
       * Stops the animation of this chart.
       */
      SmoothieChart.prototype.stop = function() {
        if (this.frame) {
          SmoothieChart.AnimateCompatibility.cancelAnimationFrame(this.frame);
          delete this.frame;
          this.canvas.removeEventListener('mousemove', this.mousemove);
          this.canvas.removeEventListener('mouseout', this.mouseout);
        }
      };

      SmoothieChart.prototype.updateValueRange = function() {
        // Calculate the current scale of the chart, from all time series.
        var chartOptions = this.options,
            chartMaxValue = Number.NaN,
            chartMinValue = Number.NaN;

        for (var d = 0; d < this.seriesSet.length; d++) {
          // TODO(ndunn): We could calculate / track these values as they stream in.
          var timeSeries = this.seriesSet[d].timeSeries;
          if (timeSeries.disabled) {
              continue;
          }

          if (!isNaN(timeSeries.maxValue)) {
            chartMaxValue = !isNaN(chartMaxValue) ? Math.max(chartMaxValue, timeSeries.maxValue) : timeSeries.maxValue;
          }

          if (!isNaN(timeSeries.minValue)) {
            chartMinValue = !isNaN(chartMinValue) ? Math.min(chartMinValue, timeSeries.minValue) : timeSeries.minValue;
          }
        }

        // Scale the chartMaxValue to add padding at the top if required
        if (chartOptions.maxValue != null) {
          chartMaxValue = chartOptions.maxValue;
        } else {
          chartMaxValue *= chartOptions.maxValueScale;
        }

        // Set the minimum if we've specified one
        if (chartOptions.minValue != null) {
          chartMinValue = chartOptions.minValue;
        } else {
          chartMinValue -= Math.abs(chartMinValue * chartOptions.minValueScale - chartMinValue);
        }

        // If a custom range function is set, call it
        if (this.options.yRangeFunction) {
          var range = this.options.yRangeFunction({min: chartMinValue, max: chartMaxValue});
          chartMinValue = range.min;
          chartMaxValue = range.max;
        }

        if (!isNaN(chartMaxValue) && !isNaN(chartMinValue)) {
          var targetValueRange = chartMaxValue - chartMinValue;
          var valueRangeDiff = (targetValueRange - this.currentValueRange);
          var minValueDiff = (chartMinValue - this.currentVisMinValue);
          this.isAnimatingScale = Math.abs(valueRangeDiff) > 0.1 || Math.abs(minValueDiff) > 0.1;
          this.currentValueRange += chartOptions.scaleSmoothing * valueRangeDiff;
          this.currentVisMinValue += chartOptions.scaleSmoothing * minValueDiff;
        }

        this.valueRange = { min: chartMinValue, max: chartMaxValue };
      };

      SmoothieChart.prototype.render = function(canvas, time) {
        var nowMillis = Date.now();

        // Respect any frame rate limit.
        if (this.options.limitFPS > 0 && nowMillis - this.lastRenderTimeMillis < (1000/this.options.limitFPS))
          return;

        time = (time || nowMillis) - (this.delay || 0);

        // Round time down to pixel granularity, so motion appears smoother.
        time -= time % this.options.millisPerPixel;

        if (!this.isAnimatingScale) {
          // We're not animating. We can use the last render time and the scroll speed to work out whether
          // we actually need to paint anything yet. If not, we can return immediately.
          var sameTime = this.lastChartTimestamp === time;
          if (sameTime) {
            // Render at least every 1/6th of a second. The canvas may be resized, which there is
            // no reliable way to detect.
            var needToRenderInCaseCanvasResized = nowMillis - this.lastRenderTimeMillis > 1000/6;
            if (!needToRenderInCaseCanvasResized) {
              return;
            }
          }
        }

        this.lastRenderTimeMillis = nowMillis;
        this.lastChartTimestamp = time;

        this.resize();

        canvas = canvas || this.canvas;
        var context = canvas.getContext('2d'),
            chartOptions = this.options,
            // Using `this.clientWidth` instead of `canvas.clientWidth` because the latter is slow.
            dimensions = { top: 0, left: 0, width: this.clientWidth, height: this.clientHeight },
            // Calculate the threshold time for the oldest data points.
            oldestValidTime = time - (dimensions.width * chartOptions.millisPerPixel),
            valueToYPosition = function(value, lineWidth) {
              var offset = value - this.currentVisMinValue,
                  unsnapped = this.currentValueRange === 0
                    ? dimensions.height
                    : dimensions.height * (1 - offset / this.currentValueRange);
              return Util.pixelSnap(unsnapped, lineWidth);
            }.bind(this),
            timeToXPosition = function(t, lineWidth) {
              var unsnapped = chartOptions.scrollBackwards
                ? (time - t) / chartOptions.millisPerPixel
                : dimensions.width - ((time - t) / chartOptions.millisPerPixel);
              return Util.pixelSnap(unsnapped, lineWidth);
            };

        this.updateValueRange();

        context.font = chartOptions.labels.fontSize + 'px ' + chartOptions.labels.fontFamily;

        // Save the state of the canvas context, any transformations applied in this method
        // will get removed from the stack at the end of this method when .restore() is called.
        context.save();

        // Move the origin.
        context.translate(dimensions.left, dimensions.top);

        // Create a clipped rectangle - anything we draw will be constrained to this rectangle.
        // This prevents the occasional pixels from curves near the edges overrunning and creating
        // screen cheese (that phrase should need no explanation).
        context.beginPath();
        context.rect(0, 0, dimensions.width, dimensions.height);
        context.clip();

        // Clear the working area.
        context.save();
        context.fillStyle = chartOptions.grid.fillStyle;
        context.clearRect(0, 0, dimensions.width, dimensions.height);
        context.fillRect(0, 0, dimensions.width, dimensions.height);
        context.restore();

        // Grid lines...
        context.save();
        context.lineWidth = chartOptions.grid.lineWidth;
        context.strokeStyle = chartOptions.grid.strokeStyle;
        // Vertical (time) dividers.
        if (chartOptions.grid.millisPerLine > 0) {
          context.beginPath();
          for (var t = time - (time % chartOptions.grid.millisPerLine);
               t >= oldestValidTime;
               t -= chartOptions.grid.millisPerLine) {
            var gx = timeToXPosition(t, chartOptions.grid.lineWidth);
            context.moveTo(gx, 0);
            context.lineTo(gx, dimensions.height);
          }
          context.stroke();
          context.closePath();
        }

        // Horizontal (value) dividers.
        for (var v = 1; v < chartOptions.grid.verticalSections; v++) {
          var gy = Util.pixelSnap(v * dimensions.height / chartOptions.grid.verticalSections, chartOptions.grid.lineWidth);
          context.beginPath();
          context.moveTo(0, gy);
          context.lineTo(dimensions.width, gy);
          context.stroke();
          context.closePath();
        }
        // Bounding rectangle.
        if (chartOptions.grid.borderVisible) {
          context.beginPath();
          context.strokeRect(0, 0, dimensions.width, dimensions.height);
          context.closePath();
        }
        context.restore();

        // Draw any horizontal lines...
        if (chartOptions.horizontalLines && chartOptions.horizontalLines.length) {
          for (var hl = 0; hl < chartOptions.horizontalLines.length; hl++) {
            var line = chartOptions.horizontalLines[hl],
                lineWidth = line.lineWidth || 1,
                hly = valueToYPosition(line.value, lineWidth);
            context.strokeStyle = line.color || '#ffffff';
            context.lineWidth = lineWidth;
            context.beginPath();
            context.moveTo(0, hly);
            context.lineTo(dimensions.width, hly);
            context.stroke();
            context.closePath();
          }
        }

        // For each data set...
        for (var d = 0; d < this.seriesSet.length; d++) {
          var timeSeries = this.seriesSet[d].timeSeries,
              dataSet = timeSeries.data;

          // Delete old data that's moved off the left of the chart.
          timeSeries.dropOldData(oldestValidTime, chartOptions.maxDataSetLength);
          if (dataSet.length <= 1 || timeSeries.disabled) {
              continue;
          }
          context.save();

          var seriesOptions = this.seriesSet[d].options,
              // Keep in mind that `context.lineWidth = 0` doesn't actually set it to `0`.
              drawStroke = seriesOptions.strokeStyle && seriesOptions.strokeStyle !== 'none',
              lineWidthMaybeZero = drawStroke ? seriesOptions.lineWidth : 0;

          // Draw the line...
          context.beginPath();
          // Retain lastX, lastY for calculating the control points of bezier curves.
          var firstX = timeToXPosition(dataSet[0][0], lineWidthMaybeZero),
            firstY = valueToYPosition(dataSet[0][1], lineWidthMaybeZero),
            lastX = firstX,
            lastY = firstY,
            draw;
          context.moveTo(firstX, firstY);
          switch (seriesOptions.interpolation || chartOptions.interpolation) {
            case "linear":
            case "line": {
              draw = function(x, y, lastX, lastY) {
                context.lineTo(x,y);
              };
              break;
            }
            case "bezier":
            default: {
              // Great explanation of Bezier curves: http://en.wikipedia.org/wiki/Bezier_curve#Quadratic_curves
              //
              // Assuming A was the last point in the line plotted and B is the new point,
              // we draw a curve with control points P and Q as below.
              //
              // A---P
              //     |
              //     |
              //     |
              //     Q---B
              //
              // Importantly, A and P are at the same y coordinate, as are B and Q. This is
              // so adjacent curves appear to flow as one.
              //
              draw = function(x, y, lastX, lastY) {
                context.bezierCurveTo( // startPoint (A) is implicit from last iteration of loop
                  Math.round((lastX + x) / 2), lastY, // controlPoint1 (P)
                  Math.round((lastX + x)) / 2, y, // controlPoint2 (Q)
                  x, y); // endPoint (B)
              };
              break;
            }
            case "step": {
              draw = function(x, y, lastX, lastY) {
                context.lineTo(x,lastY);
                context.lineTo(x,y);
              };
              break;
            }
          }

          for (var i = 1; i < dataSet.length; i++) {
            var iThData = dataSet[i],
                x = timeToXPosition(iThData[0], lineWidthMaybeZero),
                y = valueToYPosition(iThData[1], lineWidthMaybeZero);
            draw(x, y, lastX, lastY);
            lastX = x; lastY = y;
          }

          if (drawStroke) {
            context.lineWidth = seriesOptions.lineWidth;
            context.strokeStyle = seriesOptions.strokeStyle;
            context.stroke();
          }

          if (seriesOptions.fillStyle) {
            // Close up the fill region.
            context.lineTo(lastX, dimensions.height + lineWidthMaybeZero + 1);
            context.lineTo(firstX, dimensions.height + lineWidthMaybeZero + 1);

            context.fillStyle = seriesOptions.fillStyle;
            context.fill();
          }

          context.restore();
        }

        if (chartOptions.tooltip && this.mouseX >= 0) {
          // Draw vertical bar to show tooltip position
          context.lineWidth = chartOptions.tooltipLine.lineWidth;
          context.strokeStyle = chartOptions.tooltipLine.strokeStyle;
          context.beginPath();
          context.moveTo(this.mouseX, 0);
          context.lineTo(this.mouseX, dimensions.height);
          context.closePath();
          context.stroke();
        }
        this.updateTooltip();

        var labelsOptions = chartOptions.labels;
        // Draw the axis values on the chart.
        if (!labelsOptions.disabled && !isNaN(this.valueRange.min) && !isNaN(this.valueRange.max)) {
          var maxValueString = chartOptions.yMaxFormatter(this.valueRange.max, labelsOptions.precision),
              minValueString = chartOptions.yMinFormatter(this.valueRange.min, labelsOptions.precision),
              maxLabelPos = chartOptions.scrollBackwards ? 0 : dimensions.width - context.measureText(maxValueString).width - 2,
              minLabelPos = chartOptions.scrollBackwards ? 0 : dimensions.width - context.measureText(minValueString).width - 2;
          context.fillStyle = labelsOptions.fillStyle;
          context.fillText(maxValueString, maxLabelPos, labelsOptions.fontSize);
          context.fillText(minValueString, minLabelPos, dimensions.height - 2);
        }

        // Display intermediate y axis labels along y-axis to the left of the chart
        if ( labelsOptions.showIntermediateLabels
              && !isNaN(this.valueRange.min) && !isNaN(this.valueRange.max)
              && chartOptions.grid.verticalSections > 0) {
          // show a label above every vertical section divider
          var step = (this.valueRange.max - this.valueRange.min) / chartOptions.grid.verticalSections;
          var stepPixels = dimensions.height / chartOptions.grid.verticalSections;
          for (var v = 1; v < chartOptions.grid.verticalSections; v++) {
            var gy = dimensions.height - Math.round(v * stepPixels),
                yValue = chartOptions.yIntermediateFormatter(this.valueRange.min + (v * step), labelsOptions.precision),
                //left of right axis?
                intermediateLabelPos =
                  labelsOptions.intermediateLabelSameAxis
                  ? (chartOptions.scrollBackwards ? 0 : dimensions.width - context.measureText(yValue).width - 2)
                  : (chartOptions.scrollBackwards ? dimensions.width - context.measureText(yValue).width - 2 : 0);

            context.fillText(yValue, intermediateLabelPos, gy - chartOptions.grid.lineWidth);
          }
        }

        // Display timestamps along x-axis at the bottom of the chart.
        if (chartOptions.timestampFormatter && chartOptions.grid.millisPerLine > 0) {
          var textUntilX = chartOptions.scrollBackwards
            ? context.measureText(minValueString).width
            : dimensions.width - context.measureText(minValueString).width + 4;
          for (var t = time - (time % chartOptions.grid.millisPerLine);
               t >= oldestValidTime;
               t -= chartOptions.grid.millisPerLine) {
            var gx = timeToXPosition(t, 0);
            // Only draw the timestamp if it won't overlap with the previously drawn one.
            if ((!chartOptions.scrollBackwards && gx < textUntilX) || (chartOptions.scrollBackwards && gx > textUntilX))  {
              // Formats the timestamp based on user specified formatting function
              // SmoothieChart.timeFormatter function above is one such formatting option
              var tx = new Date(t),
                ts = chartOptions.timestampFormatter(tx),
                tsWidth = context.measureText(ts).width;

              textUntilX = chartOptions.scrollBackwards
                ? gx + tsWidth + 2
                : gx - tsWidth - 2;

              context.fillStyle = chartOptions.labels.fillStyle;
              if(chartOptions.scrollBackwards) {
                context.fillText(ts, gx, dimensions.height - 2);
              } else {
                context.fillText(ts, gx - tsWidth, dimensions.height - 2);
              }
            }
          }
        }

        // Display title.
        if (chartOptions.title.text !== '') {
          context.font = chartOptions.title.fontSize + 'px ' + chartOptions.title.fontFamily;
          var titleXPos = chartOptions.scrollBackwards ? dimensions.width - context.measureText(chartOptions.title.text).width - 2 : 2;
          if (chartOptions.title.verticalAlign == 'bottom') {
            context.textBaseline = 'bottom';
            var titleYPos = dimensions.height;
          } else if (chartOptions.title.verticalAlign == 'middle') {
            context.textBaseline = 'middle';
            var titleYPos = dimensions.height / 2;
          } else {
            context.textBaseline = 'top';
            var titleYPos = 0;
          }
          context.fillStyle = chartOptions.title.fillStyle;
          context.fillText(chartOptions.title.text, titleXPos, titleYPos);
        }

        context.restore(); // See .save() above.
      };

      // Sample timestamp formatting function
      SmoothieChart.timeFormatter = function(date) {
        function pad2(number) { return (number < 10 ? '0' : '') + number }
        return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
      };

      exports.TimeSeries = TimeSeries;
      exports.SmoothieChart = SmoothieChart;

    })(exports);
    });

    var css_248z$3 = "canvas.svelte-178hixk.svelte-178hixk{border-bottom:1px dashed #202020}div.smoothie-chart-tooltip{background:#363636;padding:1em;margin-top:20px;color:white;font-size:10px;pointer-events:none}.graph-pane.svelte-178hixk.svelte-178hixk{position:relative}.graph-pane.svelte-178hixk .button.svelte-178hixk{position:absolute;left:8px;top:8px}.modal-background.svelte-178hixk.svelte-178hixk{background-color:rgba(10, 10, 10, 0.4)}.modal-card.svelte-178hixk input.svelte-178hixk{font-family:\"Courier New\", Courier, monospace}";
    styleInject(css_248z$3);

    /* src/chart.svelte generated by Svelte v3.49.0 */

    const { Object: Object_1, console: console_1$1 } = globals;
    const file$3 = "src/chart.svelte";

    function get_each_context$2(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[0] = list[i];
    	child_ctx[22] = i;
    	return child_ctx;
    }

    // (166:20) {#each CHART_SPEEDS as speed, i}
    function create_each_block$2(ctx) {
    	let option;
    	let t_value = /*speed*/ ctx[0].name + "";
    	let t;

    	const block = {
    		c: function create() {
    			option = element("option");
    			t = text(t_value);
    			option.__value = /*i*/ ctx[22];
    			option.value = option.__value;
    			add_location(option, file$3, 166, 22, 4311);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, option, anchor);
    			append_dev(option, t);
    		},
    		p: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(option);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_each_block$2.name,
    		type: "each",
    		source: "(166:20) {#each CHART_SPEEDS as speed, i}",
    		ctx
    	});

    	return block;
    }

    // (190:14) {#if regExpError}
    function create_if_block$2(ctx) {
    	let p;
    	let t;

    	const block = {
    		c: function create() {
    			p = element("p");
    			t = text(/*regExpError*/ ctx[2]);
    			attr_dev(p, "class", "help is-danger");
    			add_location(p, file$3, 190, 16, 5075);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, p, anchor);
    			append_dev(p, t);
    		},
    		p: function update(ctx, dirty) {
    			if (dirty & /*regExpError*/ 4) set_data_dev(t, /*regExpError*/ ctx[2]);
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(p);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_if_block$2.name,
    		type: "if",
    		source: "(190:14) {#if regExpError}",
    		ctx
    	});

    	return block;
    }

    function create_fragment$3(ctx) {
    	let div16;
    	let canvas;
    	let t0;
    	let button0;
    	let span;
    	let settingsicon;
    	let t1;
    	let div15;
    	let div0;
    	let t2;
    	let div14;
    	let header;
    	let p;
    	let t4;
    	let button1;
    	let t5;
    	let section;
    	let div7;
    	let div2;
    	let div1;
    	let t7;
    	let div6;
    	let div5;
    	let div4;
    	let div3;
    	let select;
    	let t8;
    	let div13;
    	let div9;
    	let div8;
    	let t10;
    	let div12;
    	let div11;
    	let div10;
    	let input;
    	let input_value_value;
    	let t11;
    	let t12;
    	let footer;
    	let current;
    	let mounted;
    	let dispose;
    	settingsicon = new SettingsIcon({ $$inline: true });
    	let each_value = /*CHART_SPEEDS*/ ctx[4];
    	validate_each_argument(each_value);
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$2(get_each_context$2(ctx, each_value, i));
    	}

    	let if_block = /*regExpError*/ ctx[2] && create_if_block$2(ctx);

    	const block = {
    		c: function create() {
    			div16 = element("div");
    			canvas = element("canvas");
    			t0 = space();
    			button0 = element("button");
    			span = element("span");
    			create_component(settingsicon.$$.fragment);
    			t1 = space();
    			div15 = element("div");
    			div0 = element("div");
    			t2 = space();
    			div14 = element("div");
    			header = element("header");
    			p = element("p");
    			p.textContent = "Graph Settings";
    			t4 = space();
    			button1 = element("button");
    			t5 = space();
    			section = element("section");
    			div7 = element("div");
    			div2 = element("div");
    			div1 = element("div");
    			div1.textContent = "Scroll Speed";
    			t7 = space();
    			div6 = element("div");
    			div5 = element("div");
    			div4 = element("div");
    			div3 = element("div");
    			select = element("select");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t8 = space();
    			div13 = element("div");
    			div9 = element("div");
    			div8 = element("div");
    			div8.textContent = "Points RegExp";
    			t10 = space();
    			div12 = element("div");
    			div11 = element("div");
    			div10 = element("div");
    			input = element("input");
    			t11 = space();
    			if (if_block) if_block.c();
    			t12 = space();
    			footer = element("footer");
    			attr_dev(canvas, "height", "250");
    			attr_dev(canvas, "width", "400");
    			attr_dev(canvas, "class", "svelte-178hixk");
    			add_location(canvas, file$3, 138, 2, 3290);
    			attr_dev(span, "class", "icon is-small");
    			add_location(span, file$3, 144, 4, 3460);
    			attr_dev(button0, "class", "button is-small is-primary is-outlined svelte-178hixk");
    			attr_dev(button0, "title", "Graph Settings");
    			add_location(button0, file$3, 139, 2, 3338);
    			attr_dev(div0, "class", "modal-background svelte-178hixk");
    			add_location(div0, file$3, 149, 4, 3593);
    			attr_dev(p, "class", "modal-card-title");
    			add_location(p, file$3, 152, 8, 3702);
    			attr_dev(button1, "class", "delete");
    			attr_dev(button1, "aria-label", "close");
    			add_location(button1, file$3, 153, 8, 3757);
    			attr_dev(header, "class", "modal-card-head");
    			add_location(header, file$3, 151, 6, 3661);
    			attr_dev(div1, "class", "label");
    			add_location(div1, file$3, 158, 12, 3982);
    			attr_dev(div2, "class", "field-label is-small");
    			add_location(div2, file$3, 157, 10, 3935);
    			if (/*speed*/ ctx[0] === void 0) add_render_callback(() => /*select_change_handler*/ ctx[11].call(select));
    			add_location(select, file$3, 164, 18, 4208);
    			attr_dev(div3, "class", "select is-fullwidth");
    			add_location(div3, file$3, 163, 16, 4156);
    			attr_dev(div4, "class", "control");
    			add_location(div4, file$3, 162, 14, 4118);
    			attr_dev(div5, "class", "field");
    			add_location(div5, file$3, 161, 12, 4084);
    			attr_dev(div6, "class", "field-body");
    			add_location(div6, file$3, 160, 10, 4047);
    			attr_dev(div7, "class", "field is-horizontal");
    			add_location(div7, file$3, 156, 8, 3891);
    			attr_dev(div8, "class", "label");
    			add_location(div8, file$3, 176, 12, 4601);
    			attr_dev(div9, "class", "field-label is-small");
    			add_location(div9, file$3, 175, 10, 4554);
    			attr_dev(input, "class", "input svelte-178hixk");
    			attr_dev(input, "type", "text");
    			input.value = input_value_value = /*pointExtractRegEx*/ ctx[1].source;
    			toggle_class(input, "is-danger", /*regExpError*/ ctx[2]);
    			add_location(input, file$3, 181, 16, 4776);
    			attr_dev(div10, "class", "control");
    			add_location(div10, file$3, 180, 14, 4738);
    			attr_dev(div11, "class", "field");
    			add_location(div11, file$3, 179, 12, 4704);
    			attr_dev(div12, "class", "field-body");
    			add_location(div12, file$3, 178, 10, 4667);
    			attr_dev(div13, "class", "field is-horizontal");
    			add_location(div13, file$3, 174, 8, 4510);
    			attr_dev(section, "class", "modal-card-body");
    			add_location(section, file$3, 155, 6, 3849);
    			attr_dev(footer, "class", "modal-card-foot");
    			add_location(footer, file$3, 196, 6, 5213);
    			attr_dev(div14, "class", "modal-card svelte-178hixk");
    			add_location(div14, file$3, 150, 4, 3630);
    			attr_dev(div15, "class", "modal");
    			toggle_class(div15, "is-active", /*settingsOpen*/ ctx[3]);
    			add_location(div15, file$3, 148, 2, 3538);
    			attr_dev(div16, "class", "graph-pane svelte-178hixk");
    			add_location(div16, file$3, 137, 0, 3263);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div16, anchor);
    			append_dev(div16, canvas);
    			append_dev(div16, t0);
    			append_dev(div16, button0);
    			append_dev(button0, span);
    			mount_component(settingsicon, span, null);
    			append_dev(div16, t1);
    			append_dev(div16, div15);
    			append_dev(div15, div0);
    			append_dev(div15, t2);
    			append_dev(div15, div14);
    			append_dev(div14, header);
    			append_dev(header, p);
    			append_dev(header, t4);
    			append_dev(header, button1);
    			append_dev(div14, t5);
    			append_dev(div14, section);
    			append_dev(section, div7);
    			append_dev(div7, div2);
    			append_dev(div2, div1);
    			append_dev(div7, t7);
    			append_dev(div7, div6);
    			append_dev(div6, div5);
    			append_dev(div5, div4);
    			append_dev(div4, div3);
    			append_dev(div3, select);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(select, null);
    			}

    			select_option(select, /*speed*/ ctx[0]);
    			append_dev(section, t8);
    			append_dev(section, div13);
    			append_dev(div13, div9);
    			append_dev(div9, div8);
    			append_dev(div13, t10);
    			append_dev(div13, div12);
    			append_dev(div12, div11);
    			append_dev(div11, div10);
    			append_dev(div10, input);
    			append_dev(div11, t11);
    			if (if_block) if_block.m(div11, null);
    			append_dev(div14, t12);
    			append_dev(div14, footer);
    			current = true;

    			if (!mounted) {
    				dispose = [
    					action_destroyer(/*graph*/ ctx[8].call(null, canvas)),
    					listen_dev(button0, "click", /*openSettings*/ ctx[5], false, false, false),
    					listen_dev(button1, "click", /*closeSettings*/ ctx[6], false, false, false),
    					listen_dev(select, "change", /*select_change_handler*/ ctx[11]),
    					listen_dev(input, "change", /*updateRegExp*/ ctx[7], false, false, false)
    				];

    				mounted = true;
    			}
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*CHART_SPEEDS*/ 16) {
    				each_value = /*CHART_SPEEDS*/ ctx[4];
    				validate_each_argument(each_value);
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$2(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$2(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(select, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}

    			if (dirty & /*speed*/ 1) {
    				select_option(select, /*speed*/ ctx[0]);
    			}

    			if (!current || dirty & /*pointExtractRegEx*/ 2 && input_value_value !== (input_value_value = /*pointExtractRegEx*/ ctx[1].source) && input.value !== input_value_value) {
    				prop_dev(input, "value", input_value_value);
    			}

    			if (dirty & /*regExpError*/ 4) {
    				toggle_class(input, "is-danger", /*regExpError*/ ctx[2]);
    			}

    			if (/*regExpError*/ ctx[2]) {
    				if (if_block) {
    					if_block.p(ctx, dirty);
    				} else {
    					if_block = create_if_block$2(ctx);
    					if_block.c();
    					if_block.m(div11, null);
    				}
    			} else if (if_block) {
    				if_block.d(1);
    				if_block = null;
    			}

    			if (dirty & /*settingsOpen*/ 8) {
    				toggle_class(div15, "is-active", /*settingsOpen*/ ctx[3]);
    			}
    		},
    		i: function intro(local) {
    			if (current) return;
    			transition_in(settingsicon.$$.fragment, local);
    			current = true;
    		},
    		o: function outro(local) {
    			transition_out(settingsicon.$$.fragment, local);
    			current = false;
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div16);
    			destroy_component(settingsicon);
    			destroy_each(each_blocks, detaching);
    			if (if_block) if_block.d();
    			mounted = false;
    			run_all(dispose);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$3.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    const DefaultExtractRegExp = "[.\\d]+";

    function instance$3($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('Chart', slots, []);

    	const CHART_SPEEDS = [
    		{ name: "Slow", value: 333 },
    		{ name: "Moderate", value: 100 },
    		{ name: "Normal", value: 50 },
    		{ name: "Quick", value: 25 },
    		{ name: "Fast", value: 10 },
    		{ name: "Brief", value: 5 }
    	];

    	const LEGEND = {
    		colors: [
    			"#ff3860",
    			"#22d15f",
    			"#1f9cee",
    			"#f5f5f5",
    			"#ffdd56",
    			"#ea80fc",
    			"#ff5722",
    			"#69f0ae",
    			"#b388ff",
    			"#76ff03"
    		],
    		lineWidth: 2
    	};

    	let pointExtractRegEx = new RegExp(DefaultExtractRegExp, "gi");
    	let regExpError = null;
    	let decoder = new TextDecoder("utf-8");
    	let accumulator = "";
    	let settingsOpen = false;
    	let speed = 2;
    	const { TimeSeries, SmoothieChart } = smoothie;

    	const chart = new SmoothieChart({
    			millisPerPixel: CHART_SPEEDS[speed].value,
    			tooltip: true,
    			grid: {
    				strokeStyle: "#202020",
    				borderVisible: false,
    				millisPerLine: CHART_SPEEDS[speed].value * 100,
    				verticalSections: 4,
    				sharpLines: true
    			}
    		});

    	const series = [];

    	for (let index = 0; index < LEGEND.colors.length; index++) {
    		const ds = new TimeSeries();
    		series.push(ds);

    		chart.addTimeSeries(ds, {
    			strokeStyle: LEGEND.colors[index],
    			lineWidth: LEGEND.lineWidth
    		});
    	}

    	function clear() {
    		for (const ds of series) {
    			ds.clear();
    		}

    		decoder = new TextDecoder("utf-8");
    		accumulator = "";
    	}

    	function pushData(buffer) {
    		accumulator += decoder.decode(buffer, { stream: true });

    		for (const line of readLine()) {
    			const points = [...line.matchAll(pointExtractRegEx)].map(match => {
    				if (match.groups) {
    					return Object.entries(match.groups).sort((a, b) => a[0].localeCompare(b[0])).map(entry => entry[1]);
    				}

    				return match.length == 1 ? [match[0]] : match.slice(1);
    			}).flatMap(x => x).map(x => parseFloat(x)).filter(Boolean);

    			for (let index = 0; index < points.length; index++) {
    				pushPoints(index, points[index]);
    			}
    		}
    	}

    	function pushPoints(index, point) {
    		const ds = series[index];
    		ds && ds.append(Date.now(), point);
    	}

    	function* readLine() {
    		while (true) {
    			const index = accumulator.indexOf("\n");

    			if (index < 0) {
    				return;
    			}

    			yield accumulator.slice(0, index + 1);
    			accumulator = accumulator.slice(index + 1);
    		}
    	}

    	function openSettings() {
    		$$invalidate(3, settingsOpen = true);
    	}

    	function closeSettings() {
    		$$invalidate(3, settingsOpen = false);
    	}

    	function updateRegExp(ev) {
    		try {
    			$$invalidate(1, pointExtractRegEx = new RegExp(ev.target.value || DefaultExtractRegExp, "gi"));
    			$$invalidate(2, regExpError = null);
    		} catch(err) {
    			console.log(err);
    			$$invalidate(2, regExpError = err.message);
    		}
    	}

    	function graph(node) {
    		chart.streamTo(node, 300);
    		node.width = node.parentElement.clientWidth;
    	}

    	const writable_props = [];

    	Object_1.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console_1$1.warn(`<Chart> was created with unknown prop '${key}'`);
    	});

    	function select_change_handler() {
    		speed = select_value(this);
    		$$invalidate(0, speed);
    	}

    	$$self.$capture_state = () => ({
    		Smoothie: smoothie,
    		SettingsIcon,
    		CHART_SPEEDS,
    		LEGEND,
    		DefaultExtractRegExp,
    		pointExtractRegEx,
    		regExpError,
    		decoder,
    		accumulator,
    		settingsOpen,
    		speed,
    		TimeSeries,
    		SmoothieChart,
    		chart,
    		series,
    		clear,
    		pushData,
    		pushPoints,
    		readLine,
    		openSettings,
    		closeSettings,
    		updateRegExp,
    		graph
    	});

    	$$self.$inject_state = $$props => {
    		if ('pointExtractRegEx' in $$props) $$invalidate(1, pointExtractRegEx = $$props.pointExtractRegEx);
    		if ('regExpError' in $$props) $$invalidate(2, regExpError = $$props.regExpError);
    		if ('decoder' in $$props) decoder = $$props.decoder;
    		if ('accumulator' in $$props) accumulator = $$props.accumulator;
    		if ('settingsOpen' in $$props) $$invalidate(3, settingsOpen = $$props.settingsOpen);
    		if ('speed' in $$props) $$invalidate(0, speed = $$props.speed);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*speed*/ 1) {
    			{
    				chart.options.grid.millisPerLine = CHART_SPEEDS[speed].value * 100;
    				chart.options.millisPerPixel = CHART_SPEEDS[speed].value;
    			}
    		}
    	};

    	return [
    		speed,
    		pointExtractRegEx,
    		regExpError,
    		settingsOpen,
    		CHART_SPEEDS,
    		openSettings,
    		closeSettings,
    		updateRegExp,
    		graph,
    		clear,
    		pushData,
    		select_change_handler
    	];
    }

    class Chart extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$3, create_fragment$3, safe_not_equal, { clear: 9, pushData: 10 });

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "Chart",
    			options,
    			id: create_fragment$3.name
    		});
    	}

    	get clear() {
    		return this.$$.ctx[9];
    	}

    	set clear(value) {
    		throw new Error("<Chart>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get pushData() {
    		return this.$$.ctx[10];
    	}

    	set pushData(value) {
    		throw new Error("<Chart>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    var qwertyStandard = [{
    	"row": 0,
    	"value": "q"
    }, {
    	"row": 0,
    	"value": "w"
    }, {
    	"row": 0,
    	"value": "e"
    }, {
    	"row": 0,
    	"value": "r"
    }, {
    	"row": 0,
    	"value": "t"
    }, {
    	"row": 0,
    	"value": "y"
    }, {
    	"row": 0,
    	"value": "u"
    },  {
    	"row": 0,
    	"value": "i"
    },  {
    	"row": 0,
    	"value": "o"
    },  {
    	"row": 0,
    	"value": "p"
    }, {
    	"row": 1,
    	"value": "a"
    }, {
    	"row": 1,
    	"value": "s"
    }, {
    	"row": 1,
    	"value": "d"
    }, {
    	"row": 1,
    	"value": "f"
    }, {
    	"row": 1,
    	"value": "g"
    }, {
    	"row": 1,
    	"value": "h"
    }, {
    	"row": 1,
    	"value": "j"
    }, {
    	"row": 1,
    	"value": "k"
    }, {
    	"row": 1,
    	"value": "l"
    }, {
    	"row": 2,
    	"value": "Shift",
    }, {
    	"row": 2,
    	"value": "z"
    }, {
    	"row": 2,
    	"value": "x"
    }, {
    	"row": 2,
    	"value": "c"
    }, {
    	"row": 2,
    	"value": "v"
    }, {
    	"row": 2,
    	"value": "b"
    }, {
    	"row": 2,
    	"value": "n"
    }, {
    	"row": 2,
    	"value": "m"
    }, {
    	"row": 2,
    	"value": "Backspace"
    }, {
    	"row": 3,
    	"value": "Page1",
    },  {
    	"row": 3,
    	"value": ",",
    },  {
    	"row": 3,
    	"value": "Space",
    },  {
    	"row": 3,
    	"value": ".",
    },  {
    	"row": 3,
    	"value": "Enter",
    }, {
    	"row": 0,
    	"value": "1",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "2",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "3",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "4",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "5",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "6",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "7",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "8",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "9",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "0",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "!",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "@",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "#",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "$",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "%",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "^",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "&",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "*",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "(",
    	"page": 1
    }, {
    	"row": 1,
    	"value": ")",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "-",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "_",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "=",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "+",
    	"page": 1
    }, {
    	"row": 2,
    	"value": ";",
    	"page": 1
    }, {
    	"row": 2,
    	"value": ":",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "'",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "\"",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "<",
    	"page": 1
    }, {
    	"row": 2,
    	"value": ">",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "Page0",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "/",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "?",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "[",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "]",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "{",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "}",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "|",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "\\",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "~",
    	"page": 1
    }];

    var qwertyCrossword = [{
    	"row": 0,
    	"value": "q"
    }, {
    	"row": 0,
    	"value": "w"
    }, {
    	"row": 0,
    	"value": "e"
    }, {
    	"row": 0,
    	"value": "r"
    }, {
    	"row": 0,
    	"value": "t"
    }, {
    	"row": 0,
    	"value": "y"
    }, {
    	"row": 0,
    	"value": "u"
    }, {
    	"row": 0,
    	"value": "i"
    }, {
    	"row": 0,
    	"value": "o"
    }, {
    	"row": 0,
    	"value": "p"
    }, {
    	"row": 1,
    	"value": "a"
    }, {
    	"row": 1,
    	"value": "s"
    }, {
    	"row": 1,
    	"value": "d"
    }, {
    	"row": 1,
    	"value": "f"
    }, {
    	"row": 1,
    	"value": "g"
    }, {
    	"row": 1,
    	"value": "h"
    }, {
    	"row": 1,
    	"value": "j"
    }, {
    	"row": 1,
    	"value": "k"
    }, {
    	"row": 1,
    	"value": "l"
    }, {
    	"row": 2,
    	"value": "z"
    }, {
    	"row": 2,
    	"value": "x"
    }, {
    	"row": 2,
    	"value": "c"
    }, {
    	"row": 2,
    	"value": "v"
    }, {
    	"row": 2,
    	"value": "b"
    }, {
    	"row": 2,
    	"value": "n"
    }, {
    	"row": 2,
    	"value": "m"
    }, {
    	"row": 2,
    	"value": "Backspace"
    }];

    var qwertyWordle = [{
    	"row": 0,
    	"value": "q"
    }, {
    	"row": 0,
    	"value": "w"
    }, {
    	"row": 0,
    	"value": "e"
    }, {
    	"row": 0,
    	"value": "r"
    }, {
    	"row": 0,
    	"value": "t"
    }, {
    	"row": 0,
    	"value": "y"
    }, {
    	"row": 0,
    	"value": "u"
    }, {
    	"row": 0,
    	"value": "i"
    }, {
    	"row": 0,
    	"value": "o"
    }, {
    	"row": 0,
    	"value": "p"
    }, {
    	"row": 1,
    	"value": "a"
    }, {
    	"row": 1,
    	"value": "s"
    }, {
    	"row": 1,
    	"value": "d"
    }, {
    	"row": 1,
    	"value": "f"
    }, {
    	"row": 1,
    	"value": "g"
    }, {
    	"row": 1,
    	"value": "h"
    }, {
    	"row": 1,
    	"value": "j"
    }, {
    	"row": 1,
    	"value": "k"
    }, {
    	"row": 1,
    	"value": "l"
    }, {
    	"row": 2,
    	"value": "Enter"
    }, {
    	"row": 2,
    	"value": "z"
    }, {
    	"row": 2,
    	"value": "x"
    }, {
    	"row": 2,
    	"value": "c"
    }, {
    	"row": 2,
    	"value": "v"
    }, {
    	"row": 2,
    	"value": "b"
    }, {
    	"row": 2,
    	"value": "n"
    }, {
    	"row": 2,
    	"value": "m"
    }, {
    	"row": 2,
    	"value": "Backspace"
    }];

    var azertyStandard = [{
    	"row": 0,
    	"value": "a"
    }, {
    	"row": 0,
    	"value": "z"
    }, {
    	"row": 0,
    	"value": "e"
    }, {
    	"row": 0,
    	"value": "r"
    }, {
    	"row": 0,
    	"value": "t"
    }, {
    	"row": 0,
    	"value": "y"
    }, {
    	"row": 0,
    	"value": "u"
    },  {
    	"row": 0,
    	"value": "i"
    },  {
    	"row": 0,
    	"value": "o"
    },  {
    	"row": 0,
    	"value": "p"
    }, {
    	"row": 1,
    	"value": "q"
    }, {
    	"row": 1,
    	"value": "s"
    }, {
    	"row": 1,
    	"value": "d"
    }, {
    	"row": 1,
    	"value": "f"
    }, {
    	"row": 1,
    	"value": "g"
    }, {
    	"row": 1,
    	"value": "h"
    }, {
    	"row": 1,
    	"value": "j"
    }, {
    	"row": 1,
    	"value": "k"
    }, {
    	"row": 1,
    	"value": "l"
    }, {
    	"row": 1,
    	"value": "m"
    }, {
    	"row": 2,
    	"value": "Shift",
    }, {
    	"row": 2,
    	"value": "w"
    }, {
    	"row": 2,
    	"value": "x"
    }, {
    	"row": 2,
    	"value": "c"
    }, {
    	"row": 2,
    	"value": "v"
    }, {
    	"row": 2,
    	"value": "b"
    }, {
    	"row": 2,
    	"value": "n"
    }, {
    	"row": 2,
    	"value": "Backspace"
    }, {
    	"row": 3,
    	"value": "Page1",
    },  {
    	"row": 3,
    	"value": ",",
    },  {
    	"row": 3,
    	"value": "Space",
    },  {
    	"row": 3,
    	"value": ".",
    },  {
    	"row": 3,
    	"value": "Enter",
    }, {
    	"row": 0,
    	"value": "1",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "2",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "3",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "4",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "5",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "6",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "7",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "8",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "9",
    	"page": 1
    }, {
    	"row": 0,
    	"value": "0",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "!",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "@",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "#",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "$",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "%",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "^",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "&",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "*",
    	"page": 1
    }, {
    	"row": 1,
    	"value": "(",
    	"page": 1
    }, {
    	"row": 1,
    	"value": ")",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "-",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "_",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "=",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "+",
    	"page": 1
    }, {
    	"row": 2,
    	"value": ";",
    	"page": 1
    }, {
    	"row": 2,
    	"value": ":",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "'",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "\"",
    	"page": 1
    }, {
    	"row": 2,
    	"value": "<",
    	"page": 1
    }, {
    	"row": 2,
    	"value": ">",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "Page0",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "/",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "?",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "[",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "]",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "{",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "}",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "|",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "\\",
    	"page": 1
    }, {
    	"row": 3,
    	"value": "~",
    	"page": 1
    }];

    var azertyCrossword = [{
    	"row": 0,
    	"value": "a"
    }, {
    	"row": 0,
    	"value": "z"
    }, {
    	"row": 0,
    	"value": "e"
    }, {
    	"row": 0,
    	"value": "r"
    }, {
    	"row": 0,
    	"value": "t"
    }, {
    	"row": 0,
    	"value": "y"
    }, {
    	"row": 0,
    	"value": "u"
    }, {
    	"row": 0,
    	"value": "i"
    }, {
    	"row": 0,
    	"value": "o"
    }, {
    	"row": 0,
    	"value": "p"
    }, {
    	"row": 1,
    	"value": "q"
    }, {
    	"row": 1,
    	"value": "s"
    }, {
    	"row": 1,
    	"value": "d"
    }, {
    	"row": 1,
    	"value": "f"
    }, {
    	"row": 1,
    	"value": "g"
    }, {
    	"row": 1,
    	"value": "h"
    }, {
    	"row": 1,
    	"value": "j"
    }, {
    	"row": 1,
    	"value": "k"
    }, {
    	"row": 1,
    	"value": "l"
    }, {
    	"row": 1,
    	"value": "m"
    }, {
    	"row": 2,
    	"value": "w"
    }, {
    	"row": 2,
    	"value": "x"
    }, {
    	"row": 2,
    	"value": "c"
    }, {
    	"row": 2,
    	"value": "v"
    }, {
    	"row": 2,
    	"value": "b"
    }, {
    	"row": 2,
    	"value": "n"
    }, {
    	"row": 2,
    	"value": "Backspace"
    }];

    var azertyWordle = [{
    	"row": 0,
    	"value": "a"
    }, {
    	"row": 0,
    	"value": "z"
    }, {
    	"row": 0,
    	"value": "e"
    }, {
    	"row": 0,
    	"value": "r"
    }, {
    	"row": 0,
    	"value": "t"
    }, {
    	"row": 0,
    	"value": "y"
    }, {
    	"row": 0,
    	"value": "u"
    }, {
    	"row": 0,
    	"value": "i"
    }, {
    	"row": 0,
    	"value": "o"
    }, {
    	"row": 0,
    	"value": "p"
    }, {
    	"row": 1,
    	"value": "q"
    }, {
    	"row": 1,
    	"value": "s"
    }, {
    	"row": 1,
    	"value": "d"
    }, {
    	"row": 1,
    	"value": "f"
    }, {
    	"row": 1,
    	"value": "g"
    }, {
    	"row": 1,
    	"value": "h"
    }, {
    	"row": 1,
    	"value": "j"
    }, {
    	"row": 1,
    	"value": "k"
    }, {
    	"row": 1,
    	"value": "l"
    }, {
    	"row": 1,
    	"value": "m"
    }, {
    	"row": 2,
    	"value": "Enter"
    }, {
    	"row": 2,
    	"value": "w"
    }, {
    	"row": 2,
    	"value": "x"
    }, {
    	"row": 2,
    	"value": "c"
    }, {
    	"row": 2,
    	"value": "v"
    }, {
    	"row": 2,
    	"value": "b"
    }, {
    	"row": 2,
    	"value": "n"
    }, {
    	"row": 2,
    	"value": "Backspace"
    }];

    var backspaceSVG = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-delete"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path><line x1="18" y1="9" x2="12" y2="15"></line><line x1="12" y1="9" x2="18" y2="15"></line></svg>`;

    var enterSVG = `<svg width="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-corner-down-left"><polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg>`;

    var css_248z$2 = ".row.svelte-rguvva{display:flex;justify-content:center;touch-action:manipulation}button.svelte-rguvva{appearance:none;display:inline-block;text-align:center;vertical-align:baseline;cursor:pointer;line-height:1;transform-origin:50% 50%;user-select:none;background:var(--background, #eee);color:var(--color, #111);border:var(--border, none);border-radius:var(--border-radius, 2px);box-shadow:var(--box-shadow, none);flex:var(--flex, 1);font-family:var(--font-family, sans-serif);font-size:var(--font-size, 20px);font-weight:var(--font-weight, normal);height:var(--height, 3.5rem);margin:var(--margin, 0.125rem);opacity:var(--opacity, 1);text-transform:var(--text-transform, none);-webkit-tap-highlight-color:transparent}button.single.svelte-rguvva{min-width:var(--min-width, 2rem)}button.active.svelte-rguvva,button.svelte-rguvva:active{background:var(--active-background, #ccc);border:var(--active-border, none);box-shadow:var(--active-box-shadow, none);color:var(--active-color, #111);opacity:var(--active-opacity, 1);transform:var(--active-transform, none)}button.key--Space.svelte-rguvva{width:var(--space-width, 20%);flex:var(--space-flex, 3)}button.key--Page0.svelte-rguvva,button.key--Page1.svelte-rguvva,button.key--Shift.svelte-rguvva,button.key--Backspace.svelte-rguvva,button.key--Enter.svelte-rguvva{flex:var(--special-flex, 1.5)}.page.svelte-rguvva{display:none}.page.visible.svelte-rguvva{display:block}.svelte-keyboard svg{stroke-width:var(--stroke-width, 2px);vertical-align:middle}";
    styleInject(css_248z$2);

    /* node_modules/svelte-keyboard/Keyboard.svelte generated by Svelte v3.49.0 */
    const file$2 = "node_modules/svelte-keyboard/Keyboard.svelte";

    function get_each_context$1(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[27] = list[i];
    	child_ctx[29] = i;
    	return child_ctx;
    }

    function get_each_context_1(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[30] = list[i];
    	return child_ctx;
    }

    function get_each_context_2(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[33] = list[i].value;
    	child_ctx[34] = list[i].display;
    	return child_ctx;
    }

    // (121:14) {:else}
    function create_else_block(ctx) {
    	let t_value = /*display*/ ctx[34] + "";
    	let t;

    	const block = {
    		c: function create() {
    			t = text(t_value);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, t, anchor);
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*rowData*/ 8 && t_value !== (t_value = /*display*/ ctx[34] + "")) set_data_dev(t, t_value);
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(t);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_else_block.name,
    		type: "else",
    		source: "(121:14) {:else}",
    		ctx
    	});

    	return block;
    }

    // (119:14) {#if display.includes("<svg")}
    function create_if_block$1(ctx) {
    	let html_tag;
    	let raw_value = /*display*/ ctx[34] + "";
    	let html_anchor;

    	const block = {
    		c: function create() {
    			html_tag = new HtmlTag(false);
    			html_anchor = empty();
    			html_tag.a = html_anchor;
    		},
    		m: function mount(target, anchor) {
    			html_tag.m(raw_value, target, anchor);
    			insert_dev(target, html_anchor, anchor);
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*rowData*/ 8 && raw_value !== (raw_value = /*display*/ ctx[34] + "")) html_tag.p(raw_value);
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(html_anchor);
    			if (detaching) html_tag.d();
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_if_block$1.name,
    		type: "if",
    		source: "(119:14) {#if display.includes(\\\"<svg\\\")}",
    		ctx
    	});

    	return block;
    }

    // (109:10) {#each keys as { value, display }}
    function create_each_block_2(ctx) {
    	let button;
    	let show_if;
    	let button_class_value;
    	let mounted;
    	let dispose;

    	function select_block_type(ctx, dirty) {
    		if (dirty[0] & /*rowData*/ 8) show_if = null;
    		if (show_if == null) show_if = !!/*display*/ ctx[34].includes("<svg");
    		if (show_if) return create_if_block$1;
    		return create_else_block;
    	}

    	let current_block_type = select_block_type(ctx, [-1, -1]);
    	let if_block = current_block_type(ctx);

    	function touchstart_handler(...args) {
    		return /*touchstart_handler*/ ctx[19](/*value*/ ctx[33], ...args);
    	}

    	function mousedown_handler(...args) {
    		return /*mousedown_handler*/ ctx[20](/*value*/ ctx[33], ...args);
    	}

    	function touchend_handler() {
    		return /*touchend_handler*/ ctx[21](/*value*/ ctx[33]);
    	}

    	function mouseup_handler() {
    		return /*mouseup_handler*/ ctx[22](/*value*/ ctx[33]);
    	}

    	const block = {
    		c: function create() {
    			button = element("button");
    			if_block.c();
    			attr_dev(button, "class", button_class_value = "key key--" + /*value*/ ctx[33] + " " + (/*keyClass*/ ctx[0][/*value*/ ctx[33]] || '') + " svelte-rguvva");
    			toggle_class(button, "single", /*value*/ ctx[33].length === 1);
    			toggle_class(button, "active", /*value*/ ctx[33] === /*active*/ ctx[2]);
    			add_location(button, file$2, 109, 12, 3019);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, button, anchor);
    			if_block.m(button, null);

    			if (!mounted) {
    				dispose = [
    					listen_dev(button, "touchstart", touchstart_handler, false, false, false),
    					listen_dev(button, "mousedown", mousedown_handler, false, false, false),
    					listen_dev(button, "touchend", touchend_handler, { passive: true }, false, false),
    					listen_dev(button, "mouseup", mouseup_handler, false, false, false)
    				];

    				mounted = true;
    			}
    		},
    		p: function update(new_ctx, dirty) {
    			ctx = new_ctx;

    			if (current_block_type === (current_block_type = select_block_type(ctx, dirty)) && if_block) {
    				if_block.p(ctx, dirty);
    			} else {
    				if_block.d(1);
    				if_block = current_block_type(ctx);

    				if (if_block) {
    					if_block.c();
    					if_block.m(button, null);
    				}
    			}

    			if (dirty[0] & /*rowData, keyClass*/ 9 && button_class_value !== (button_class_value = "key key--" + /*value*/ ctx[33] + " " + (/*keyClass*/ ctx[0][/*value*/ ctx[33]] || '') + " svelte-rguvva")) {
    				attr_dev(button, "class", button_class_value);
    			}

    			if (dirty[0] & /*rowData, keyClass, rowData*/ 9) {
    				toggle_class(button, "single", /*value*/ ctx[33].length === 1);
    			}

    			if (dirty[0] & /*rowData, keyClass, rowData, active*/ 13) {
    				toggle_class(button, "active", /*value*/ ctx[33] === /*active*/ ctx[2]);
    			}
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(button);
    			if_block.d();
    			mounted = false;
    			run_all(dispose);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_each_block_2.name,
    		type: "each",
    		source: "(109:10) {#each keys as { value, display }}",
    		ctx
    	});

    	return block;
    }

    // (107:6) {#each row as keys}
    function create_each_block_1(ctx) {
    	let div;
    	let each_value_2 = /*keys*/ ctx[30];
    	validate_each_argument(each_value_2);
    	let each_blocks = [];

    	for (let i = 0; i < each_value_2.length; i += 1) {
    		each_blocks[i] = create_each_block_2(get_each_context_2(ctx, each_value_2, i));
    	}

    	const block = {
    		c: function create() {
    			div = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr_dev(div, "class", "row row--" + /*i*/ ctx[29] + " svelte-rguvva");
    			add_location(div, file$2, 107, 8, 2935);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div, null);
    			}
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*rowData, keyClass, active, onKeyStart, onKeyEnd*/ 61) {
    				each_value_2 = /*keys*/ ctx[30];
    				validate_each_argument(each_value_2);
    				let i;

    				for (i = 0; i < each_value_2.length; i += 1) {
    					const child_ctx = get_each_context_2(ctx, each_value_2, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block_2(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value_2.length;
    			}
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div);
    			destroy_each(each_blocks, detaching);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_each_block_1.name,
    		type: "each",
    		source: "(107:6) {#each row as keys}",
    		ctx
    	});

    	return block;
    }

    // (105:2) {#each rowData as row, i}
    function create_each_block$1(ctx) {
    	let div;
    	let t;
    	let each_value_1 = /*row*/ ctx[27];
    	validate_each_argument(each_value_1);
    	let each_blocks = [];

    	for (let i = 0; i < each_value_1.length; i += 1) {
    		each_blocks[i] = create_each_block_1(get_each_context_1(ctx, each_value_1, i));
    	}

    	const block = {
    		c: function create() {
    			div = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t = space();
    			attr_dev(div, "class", "page svelte-rguvva");
    			toggle_class(div, "visible", /*i*/ ctx[29] === /*page*/ ctx[1]);
    			add_location(div, file$2, 105, 4, 2853);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div, null);
    			}

    			append_dev(div, t);
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*rowData, keyClass, active, onKeyStart, onKeyEnd*/ 61) {
    				each_value_1 = /*row*/ ctx[27];
    				validate_each_argument(each_value_1);
    				let i;

    				for (i = 0; i < each_value_1.length; i += 1) {
    					const child_ctx = get_each_context_1(ctx, each_value_1, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block_1(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div, t);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value_1.length;
    			}

    			if (dirty[0] & /*page*/ 2) {
    				toggle_class(div, "visible", /*i*/ ctx[29] === /*page*/ ctx[1]);
    			}
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div);
    			destroy_each(each_blocks, detaching);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_each_block$1.name,
    		type: "each",
    		source: "(105:2) {#each rowData as row, i}",
    		ctx
    	});

    	return block;
    }

    function create_fragment$2(ctx) {
    	let div;
    	let each_value = /*rowData*/ ctx[3];
    	validate_each_argument(each_value);
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$1(get_each_context$1(ctx, each_value, i));
    	}

    	const block = {
    		c: function create() {
    			div = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr_dev(div, "class", "svelte-keyboard");
    			add_location(div, file$2, 103, 0, 2791);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div, null);
    			}
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*page, rowData, keyClass, active, onKeyStart, onKeyEnd*/ 63) {
    				each_value = /*rowData*/ ctx[3];
    				validate_each_argument(each_value);
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$1(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$1(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}
    		},
    		i: noop,
    		o: noop,
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div);
    			destroy_each(each_blocks, detaching);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$2.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    const alphabet = "abcdefghijklmnopqrstuvwxyz";

    function instance$2($$self, $$props, $$invalidate) {
    	let rawData;
    	let data;
    	let page0;
    	let page1;
    	let rows0;
    	let rows1;
    	let rowData0;
    	let rowData1;
    	let rowData;
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('Keyboard', slots, []);
    	let { custom } = $$props;
    	let { localizationLayout = "qwerty" } = $$props;
    	let { layout = "standard" } = $$props;
    	let { noSwap = [] } = $$props;
    	let { keyClass = {} } = $$props;

    	// vars
    	let page = 0;

    	let shifted = false;
    	let active = undefined;

    	const layouts = {
    		qwerty: {
    			standard: qwertyStandard,
    			crossword: qwertyCrossword,
    			wordle: qwertyWordle
    		},
    		azerty: {
    			standard: azertyStandard,
    			crossword: azertyCrossword,
    			wordle: azertyWordle
    		}
    	};

    	const dispatch = createEventDispatcher();

    	const swaps = {
    		Page0: "abc",
    		Page1: "?123",
    		Space: " ",
    		Shift: "abc",
    		Enter: enterSVG,
    		Backspace: backspaceSVG
    	};

    	// functions
    	const unique = arr => [...new Set(arr)];

    	const onKeyStart = (event, value) => {
    		event.preventDefault();
    		$$invalidate(2, active = value);

    		if (value.includes("Page")) {
    			$$invalidate(1, page = +value.substr(-1));
    		} else if (value === "Shift") {
    			$$invalidate(10, shifted = !shifted);
    		} else {
    			let output = value;
    			if (shifted && alphabet.includes(value)) output = value.toUpperCase();
    			dispatch("keydown", output);
    		}

    		event.stopPropagation();
    		return false;
    	};

    	const onKeyEnd = value => {
    		setTimeout(
    			() => {
    				if (value === active) $$invalidate(2, active = undefined);
    			},
    			50
    		);
    	};

    	const writable_props = ['custom', 'localizationLayout', 'layout', 'noSwap', 'keyClass'];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<Keyboard> was created with unknown prop '${key}'`);
    	});

    	const touchstart_handler = (value, e) => onKeyStart(e, value);
    	const mousedown_handler = (value, e) => onKeyStart(e, value);
    	const touchend_handler = value => onKeyEnd(value);
    	const mouseup_handler = value => onKeyEnd(value);

    	$$self.$$set = $$props => {
    		if ('custom' in $$props) $$invalidate(6, custom = $$props.custom);
    		if ('localizationLayout' in $$props) $$invalidate(7, localizationLayout = $$props.localizationLayout);
    		if ('layout' in $$props) $$invalidate(8, layout = $$props.layout);
    		if ('noSwap' in $$props) $$invalidate(9, noSwap = $$props.noSwap);
    		if ('keyClass' in $$props) $$invalidate(0, keyClass = $$props.keyClass);
    	};

    	$$self.$capture_state = () => ({
    		createEventDispatcher,
    		qwertyStandard,
    		qwertyCrossword,
    		qwertyWordle,
    		azertyStandard,
    		azertyCrossword,
    		azertyWordle,
    		backspaceSVG,
    		enterSVG,
    		custom,
    		localizationLayout,
    		layout,
    		noSwap,
    		keyClass,
    		page,
    		shifted,
    		active,
    		layouts,
    		dispatch,
    		alphabet,
    		swaps,
    		unique,
    		onKeyStart,
    		onKeyEnd,
    		rowData1,
    		rowData0,
    		rowData,
    		page1,
    		rows0,
    		page0,
    		rows1,
    		data,
    		rawData
    	});

    	$$self.$inject_state = $$props => {
    		if ('custom' in $$props) $$invalidate(6, custom = $$props.custom);
    		if ('localizationLayout' in $$props) $$invalidate(7, localizationLayout = $$props.localizationLayout);
    		if ('layout' in $$props) $$invalidate(8, layout = $$props.layout);
    		if ('noSwap' in $$props) $$invalidate(9, noSwap = $$props.noSwap);
    		if ('keyClass' in $$props) $$invalidate(0, keyClass = $$props.keyClass);
    		if ('page' in $$props) $$invalidate(1, page = $$props.page);
    		if ('shifted' in $$props) $$invalidate(10, shifted = $$props.shifted);
    		if ('active' in $$props) $$invalidate(2, active = $$props.active);
    		if ('rowData1' in $$props) $$invalidate(11, rowData1 = $$props.rowData1);
    		if ('rowData0' in $$props) $$invalidate(12, rowData0 = $$props.rowData0);
    		if ('rowData' in $$props) $$invalidate(3, rowData = $$props.rowData);
    		if ('page1' in $$props) $$invalidate(13, page1 = $$props.page1);
    		if ('rows0' in $$props) $$invalidate(14, rows0 = $$props.rows0);
    		if ('page0' in $$props) $$invalidate(15, page0 = $$props.page0);
    		if ('rows1' in $$props) $$invalidate(16, rows1 = $$props.rows1);
    		if ('data' in $$props) $$invalidate(17, data = $$props.data);
    		if ('rawData' in $$props) $$invalidate(18, rawData = $$props.rawData);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty[0] & /*custom, localizationLayout, layout*/ 448) {
    			// reactive vars
    			$$invalidate(18, rawData = custom || layouts[localizationLayout][layout] || standard);
    		}

    		if ($$self.$$.dirty[0] & /*rawData, noSwap, shifted*/ 263680) {
    			$$invalidate(17, data = rawData.map(d => {
    				let display = d.display;
    				const s = swaps[d.value];
    				const shouldSwap = s && !noSwap.includes(d.value) && !d.noSwap;
    				if (shouldSwap) display = s;
    				if (!display) display = shifted ? d.value.toUpperCase() : d.value;
    				if (d.value === "Shift") display = shifted ? s : s.toUpperCase();
    				return { ...d, display };
    			}));
    		}

    		if ($$self.$$.dirty[0] & /*data*/ 131072) {
    			$$invalidate(15, page0 = data.filter(d => !d.page));
    		}

    		if ($$self.$$.dirty[0] & /*data*/ 131072) {
    			$$invalidate(13, page1 = data.filter(d => d.page));
    		}

    		if ($$self.$$.dirty[0] & /*page0*/ 32768) {
    			$$invalidate(14, rows0 = unique(page0.map(d => d.row)));
    		}

    		if ($$self.$$.dirty[0] & /*rows0*/ 16384) {
    			(rows0.sort((a, b) => a - b));
    		}

    		if ($$self.$$.dirty[0] & /*page1*/ 8192) {
    			$$invalidate(16, rows1 = unique(page1.map(d => d.row)));
    		}

    		if ($$self.$$.dirty[0] & /*rows1*/ 65536) {
    			(rows1.sort((a, b) => a - b));
    		}

    		if ($$self.$$.dirty[0] & /*rows0, page0*/ 49152) {
    			$$invalidate(12, rowData0 = rows0.map(r => page0.filter(k => k.row === r)));
    		}

    		if ($$self.$$.dirty[0] & /*rows0, page1*/ 24576) {
    			$$invalidate(11, rowData1 = rows0.map(r => page1.filter(k => k.row === r)));
    		}

    		if ($$self.$$.dirty[0] & /*rowData0, rowData1*/ 6144) {
    			$$invalidate(3, rowData = [rowData0, rowData1]);
    		}
    	};

    	return [
    		keyClass,
    		page,
    		active,
    		rowData,
    		onKeyStart,
    		onKeyEnd,
    		custom,
    		localizationLayout,
    		layout,
    		noSwap,
    		shifted,
    		rowData1,
    		rowData0,
    		page1,
    		rows0,
    		page0,
    		rows1,
    		data,
    		rawData,
    		touchstart_handler,
    		mousedown_handler,
    		touchend_handler,
    		mouseup_handler
    	];
    }

    class Keyboard extends SvelteComponentDev {
    	constructor(options) {
    		super(options);

    		init(
    			this,
    			options,
    			instance$2,
    			create_fragment$2,
    			safe_not_equal,
    			{
    				custom: 6,
    				localizationLayout: 7,
    				layout: 8,
    				noSwap: 9,
    				keyClass: 0
    			},
    			null,
    			[-1, -1]
    		);

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "Keyboard",
    			options,
    			id: create_fragment$2.name
    		});

    		const { ctx } = this.$$;
    		const props = options.props || {};

    		if (/*custom*/ ctx[6] === undefined && !('custom' in props)) {
    			console.warn("<Keyboard> was created without expected prop 'custom'");
    		}
    	}

    	get custom() {
    		throw new Error("<Keyboard>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set custom(value) {
    		throw new Error("<Keyboard>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get localizationLayout() {
    		throw new Error("<Keyboard>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set localizationLayout(value) {
    		throw new Error("<Keyboard>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get layout() {
    		throw new Error("<Keyboard>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set layout(value) {
    		throw new Error("<Keyboard>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get noSwap() {
    		throw new Error("<Keyboard>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set noSwap(value) {
    		throw new Error("<Keyboard>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	get keyClass() {
    		throw new Error("<Keyboard>: Props cannot be read directly from the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}

    	set keyClass(value) {
    		throw new Error("<Keyboard>: Props cannot be set directly on the component instance unless compiling with 'accessors: true' or '<svelte:options accessors/>'");
    	}
    }

    var css_248z$1 = ".kbrd-pane.svelte-1ms6ke{position:relative}.modal-background.svelte-1ms6ke{background-color:rgba(10, 10, 10, 0.4)}";
    styleInject(css_248z$1);

    /* src/keyboard.svelte generated by Svelte v3.49.0 */

    const { console: console_1 } = globals;
    const file$1 = "src/keyboard.svelte";

    function create_fragment$1(ctx) {
    	let div4;
    	let div3;
    	let div0;
    	let t0;
    	let div2;
    	let header;
    	let p;
    	let t2;
    	let button;
    	let t3;
    	let section;
    	let div1;
    	let t4;
    	let footer;
    	let t5;
    	let keyboard;
    	let div;
    	let current;
    	let mounted;
    	let dispose;

    	keyboard = new Keyboard({
    			props: {
    				custom: [
    					{ row: 0, value: "s" },
    					{ row: 0, value: "v" },
    					{ row: 0, value: "e" },
    					{ row: 0, value: "l" },
    					{ row: 0, value: "t" },
    					{ row: 0, value: "e" },
    					{ row: 1, value: "k" },
    					{ row: 1, value: "e" },
    					{ row: 1, value: "y" },
    					{ row: 1, value: "b" },
    					{ row: 1, value: "o" },
    					{ row: 1, value: "a" },
    					{ row: 1, value: "r" },
    					{ row: 1, value: "d" }
    				]
    			},
    			$$inline: true
    		});

    	keyboard.$on("keydown", /*onKeydown*/ ctx[1]);

    	const block = {
    		c: function create() {
    			div4 = element("div");
    			div3 = element("div");
    			div0 = element("div");
    			t0 = space();
    			div2 = element("div");
    			header = element("header");
    			p = element("p");
    			p.textContent = "Keyboard Settings";
    			t2 = space();
    			button = element("button");
    			t3 = space();
    			section = element("section");
    			div1 = element("div");
    			t4 = space();
    			footer = element("footer");
    			t5 = space();
    			div = element("div");
    			create_component(keyboard.$$.fragment);
    			attr_dev(div0, "class", "modal-background svelte-1ms6ke");
    			add_location(div0, file$1, 23, 4, 519);
    			attr_dev(p, "class", "modal-card-title");
    			add_location(p, file$1, 26, 8, 628);
    			attr_dev(button, "class", "delete");
    			attr_dev(button, "aria-label", "close");
    			add_location(button, file$1, 27, 8, 686);
    			attr_dev(header, "class", "modal-card-head");
    			add_location(header, file$1, 25, 6, 587);
    			attr_dev(div1, "class", "field is-horizontal");
    			add_location(div1, file$1, 30, 8, 820);
    			attr_dev(section, "class", "modal-card-body");
    			add_location(section, file$1, 29, 6, 778);
    			attr_dev(footer, "class", "modal-card-foot");
    			add_location(footer, file$1, 32, 6, 879);
    			attr_dev(div2, "class", "modal-card");
    			add_location(div2, file$1, 24, 4, 556);
    			attr_dev(div3, "class", "modal");
    			toggle_class(div3, "is-active", /*settingsOpen*/ ctx[0]);
    			add_location(div3, file$1, 22, 2, 464);
    			attr_dev(div4, "class", "kbrd-pane svelte-1ms6ke");
    			add_location(div4, file$1, 21, 0, 438);
    			set_style(div, "display", "contents");
    			set_style(div, "--flex", "0 auto");
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div4, anchor);
    			append_dev(div4, div3);
    			append_dev(div3, div0);
    			append_dev(div3, t0);
    			append_dev(div3, div2);
    			append_dev(div2, header);
    			append_dev(header, p);
    			append_dev(header, t2);
    			append_dev(header, button);
    			append_dev(div2, t3);
    			append_dev(div2, section);
    			append_dev(section, div1);
    			append_dev(div2, t4);
    			append_dev(div2, footer);
    			insert_dev(target, t5, anchor);
    			insert_dev(target, div, anchor);
    			mount_component(keyboard, div, null);
    			current = true;

    			if (!mounted) {
    				dispose = listen_dev(button, "click", /*closeSettings*/ ctx[2], false, false, false);
    				mounted = true;
    			}
    		},
    		p: function update(ctx, [dirty]) {
    			if (dirty & /*settingsOpen*/ 1) {
    				toggle_class(div3, "is-active", /*settingsOpen*/ ctx[0]);
    			}
    		},
    		i: function intro(local) {
    			if (current) return;
    			transition_in(keyboard.$$.fragment, local);
    			current = true;
    		},
    		o: function outro(local) {
    			transition_out(keyboard.$$.fragment, local);
    			current = false;
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div4);
    			if (detaching) detach_dev(t5);
    			if (detaching) detach_dev(div);
    			destroy_component(keyboard, detaching);
    			mounted = false;
    			dispose();
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment$1.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance$1($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('Keyboard', slots, []);
    	const dispatch = createEventDispatcher();

    	const onKeydown = event => {
    		console.log(event.detail);

    		if (event.detail === "wterm:open-settings") {
    			$$invalidate(0, settingsOpen = true);
    		}

    		dispatch("message", event.detail);
    	};

    	let settingsOpen = false;

    	function closeSettings() {
    		$$invalidate(0, settingsOpen = false);
    	}

    	const writable_props = [];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console_1.warn(`<Keyboard> was created with unknown prop '${key}'`);
    	});

    	$$self.$capture_state = () => ({
    		createEventDispatcher,
    		Keyboard,
    		dispatch,
    		onKeydown,
    		settingsOpen,
    		closeSettings
    	});

    	$$self.$inject_state = $$props => {
    		if ('settingsOpen' in $$props) $$invalidate(0, settingsOpen = $$props.settingsOpen);
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [settingsOpen, onKeydown, closeSettings];
    }

    class Keyboard_1 extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance$1, create_fragment$1, safe_not_equal, {});

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "Keyboard_1",
    			options,
    			id: create_fragment$1.name
    		});
    	}
    }

    var css_248z = "html,body{padding:0;margin:0;min-height:100%;background-color:black !important}.notification-container.svelte-11r0plj.svelte-11r0plj{position:absolute;z-index:1;bottom:0;right:0;padding:1em}.workspace.svelte-11r0plj.svelte-11r0plj{display:flex;flex-direction:column;position:absolute;top:0;left:0;right:0;bottom:0}.workspace.svelte-11r0plj>.terminal.svelte-11r0plj{flex:1;overflow:hidden}.workspace.svelte-11r0plj .navbar button.svelte-11r0plj,.workspace.svelte-11r0plj .navbar button.svelte-11r0plj:focus{outline:none;border:none}.workspace.svelte-11r0plj .navbar .navbar-item input.port.svelte-11r0plj{min-width:200px}.workspace.svelte-11r0plj .navbar .navbar-item input.baudrate.svelte-11r0plj{max-width:62px}";
    styleInject(css_248z);

    /* src/app.svelte generated by Svelte v3.49.0 */
    const file = "src/app.svelte";

    function get_each_context(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[36] = list[i];
    	return child_ctx;
    }

    // (194:2) {#if error}
    function create_if_block_2(ctx) {
    	let div;
    	let t;

    	const block = {
    		c: function create() {
    			div = element("div");
    			t = text(/*error*/ ctx[4]);
    			attr_dev(div, "class", "notification is-danger");
    			add_location(div, file, 194, 4, 4478);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div, anchor);
    			append_dev(div, t);
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*error*/ 16) set_data_dev(t, /*error*/ ctx[4]);
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_if_block_2.name,
    		type: "if",
    		source: "(194:2) {#if error}",
    		ctx
    	});

    	return block;
    }

    // (316:16) {#each ports as port}
    function create_each_block(ctx) {
    	let option;
    	let option_value_value;

    	const block = {
    		c: function create() {
    			option = element("option");
    			option.__value = option_value_value = /*port*/ ctx[36];
    			option.value = option.__value;
    			add_location(option, file, 316, 18, 8262);
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, option, anchor);
    		},
    		p: function update(ctx, dirty) {
    			if (dirty[0] & /*ports*/ 8 && option_value_value !== (option_value_value = /*port*/ ctx[36])) {
    				prop_dev(option, "__value", option_value_value);
    				option.value = option.__value;
    			}
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(option);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_each_block.name,
    		type: "each",
    		source: "(316:16) {#each ports as port}",
    		ctx
    	});

    	return block;
    }

    // (346:2) {#if chartOpen}
    function create_if_block_1(ctx) {
    	let chart_1;
    	let current;
    	let chart_1_props = {};
    	chart_1 = new Chart({ props: chart_1_props, $$inline: true });
    	/*chart_1_binding*/ ctx[24](chart_1);

    	const block = {
    		c: function create() {
    			create_component(chart_1.$$.fragment);
    		},
    		m: function mount(target, anchor) {
    			mount_component(chart_1, target, anchor);
    			current = true;
    		},
    		p: function update(ctx, dirty) {
    			const chart_1_changes = {};
    			chart_1.$set(chart_1_changes);
    		},
    		i: function intro(local) {
    			if (current) return;
    			transition_in(chart_1.$$.fragment, local);
    			current = true;
    		},
    		o: function outro(local) {
    			transition_out(chart_1.$$.fragment, local);
    			current = false;
    		},
    		d: function destroy(detaching) {
    			/*chart_1_binding*/ ctx[24](null);
    			destroy_component(chart_1, detaching);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_if_block_1.name,
    		type: "if",
    		source: "(346:2) {#if chartOpen}",
    		ctx
    	});

    	return block;
    }

    // (350:2) {#if keyboardOpen}
    function create_if_block(ctx) {
    	let keyboard;
    	let current;
    	keyboard = new Keyboard_1({ $$inline: true });
    	keyboard.$on("message", /*onKeyboard*/ ctx[19]);

    	const block = {
    		c: function create() {
    			create_component(keyboard.$$.fragment);
    		},
    		m: function mount(target, anchor) {
    			mount_component(keyboard, target, anchor);
    			current = true;
    		},
    		p: noop,
    		i: function intro(local) {
    			if (current) return;
    			transition_in(keyboard.$$.fragment, local);
    			current = true;
    		},
    		o: function outro(local) {
    			transition_out(keyboard.$$.fragment, local);
    			current = false;
    		},
    		d: function destroy(detaching) {
    			destroy_component(keyboard, detaching);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_if_block.name,
    		type: "if",
    		source: "(350:2) {#if keyboardOpen}",
    		ctx
    	});

    	return block;
    }

    function create_fragment(ctx) {
    	let div0;
    	let t0;
    	let div14;
    	let nav;
    	let div2;
    	let div1;
    	let span1;
    	let span0;
    	let terminalicon;
    	let t1;
    	let t2;
    	let button0;
    	let span2;
    	let t3;
    	let span3;
    	let t4;
    	let span4;
    	let t5;
    	let div12;
    	let div5;
    	let div4;
    	let div3;
    	let button1;
    	let span5;
    	let saveicon;
    	let t6;
    	let button2;
    	let span6;
    	let trash2icon;
    	let t7;
    	let div11;
    	let div7;
    	let div6;
    	let button3;
    	let span7;
    	let barchart2icon;
    	let t8;
    	let button4;
    	let span8;
    	let cornerdownlefticon;
    	let t9;
    	let button5;
    	let span9;
    	let repeaticon;
    	let t10;
    	let div10;
    	let div9;
    	let p0;
    	let button6;
    	let span10;
    	let refreshcwicon;
    	let t11;
    	let div8;
    	let input0;
    	let input0_disabled_value;
    	let t12;
    	let datalist;
    	let t13;
    	let p1;
    	let input1;
    	let input1_disabled_value;
    	let t14;
    	let p2;
    	let button7;
    	let t15_value = (/*connected*/ ctx[6] ? "Disconnect" : "Connect") + "";
    	let t15;
    	let t16;
    	let t17;
    	let div13;
    	let t18;
    	let current;
    	let mounted;
    	let dispose;
    	let if_block0 = /*error*/ ctx[4] && create_if_block_2(ctx);
    	terminalicon = new TerminalIcon({ $$inline: true });
    	saveicon = new SaveIcon({ $$inline: true });
    	trash2icon = new Trash2Icon({ $$inline: true });
    	barchart2icon = new BarChart2Icon({ $$inline: true });
    	cornerdownlefticon = new CornerDownLeftIcon({ $$inline: true });
    	repeaticon = new RepeatIcon({ $$inline: true });
    	refreshcwicon = new RefreshCwIcon({ $$inline: true });
    	let each_value = /*ports*/ ctx[3];
    	validate_each_argument(each_value);
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block(get_each_context(ctx, each_value, i));
    	}

    	let if_block1 = /*chartOpen*/ ctx[8] && create_if_block_1(ctx);
    	let if_block2 = /*keyboardOpen*/ ctx[9] && create_if_block(ctx);

    	const block = {
    		c: function create() {
    			div0 = element("div");
    			if (if_block0) if_block0.c();
    			t0 = space();
    			div14 = element("div");
    			nav = element("nav");
    			div2 = element("div");
    			div1 = element("div");
    			span1 = element("span");
    			span0 = element("span");
    			create_component(terminalicon.$$.fragment);
    			t1 = text("\n            wterm");
    			t2 = space();
    			button0 = element("button");
    			span2 = element("span");
    			t3 = space();
    			span3 = element("span");
    			t4 = space();
    			span4 = element("span");
    			t5 = space();
    			div12 = element("div");
    			div5 = element("div");
    			div4 = element("div");
    			div3 = element("div");
    			button1 = element("button");
    			span5 = element("span");
    			create_component(saveicon.$$.fragment);
    			t6 = space();
    			button2 = element("button");
    			span6 = element("span");
    			create_component(trash2icon.$$.fragment);
    			t7 = space();
    			div11 = element("div");
    			div7 = element("div");
    			div6 = element("div");
    			button3 = element("button");
    			span7 = element("span");
    			create_component(barchart2icon.$$.fragment);
    			t8 = space();
    			button4 = element("button");
    			span8 = element("span");
    			create_component(cornerdownlefticon.$$.fragment);
    			t9 = space();
    			button5 = element("button");
    			span9 = element("span");
    			create_component(repeaticon.$$.fragment);
    			t10 = space();
    			div10 = element("div");
    			div9 = element("div");
    			p0 = element("p");
    			button6 = element("button");
    			span10 = element("span");
    			create_component(refreshcwicon.$$.fragment);
    			t11 = space();
    			div8 = element("div");
    			input0 = element("input");
    			t12 = space();
    			datalist = element("datalist");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t13 = space();
    			p1 = element("p");
    			input1 = element("input");
    			t14 = space();
    			p2 = element("p");
    			button7 = element("button");
    			t15 = text(t15_value);
    			t16 = space();
    			if (if_block1) if_block1.c();
    			t17 = space();
    			div13 = element("div");
    			t18 = space();
    			if (if_block2) if_block2.c();
    			attr_dev(div0, "class", "notification-container svelte-11r0plj");
    			add_location(div0, file, 192, 0, 4423);
    			attr_dev(span0, "class", "icon is-small");
    			add_location(span0, file, 206, 10, 4810);
    			attr_dev(span1, "class", "tag is-info is-family-code is-size-6 has-text-weight-bold");
    			toggle_class(span1, "is-danger", /*connected*/ ctx[6]);
    			add_location(span1, file, 202, 8, 4670);
    			attr_dev(div1, "class", "navbar-item");
    			add_location(div1, file, 201, 6, 4636);
    			attr_dev(span2, "aria-hidden", "true");
    			add_location(span2, file, 218, 8, 5121);
    			attr_dev(span3, "aria-hidden", "true");
    			add_location(span3, file, 219, 8, 5157);
    			attr_dev(span4, "aria-hidden", "true");
    			add_location(span4, file, 220, 8, 5193);
    			attr_dev(button0, "class", "navbar-burger burger has-background-dark svelte-11r0plj");
    			attr_dev(button0, "aria-hidden", "true");
    			toggle_class(button0, "is-active", /*navbarOpen*/ ctx[7]);
    			add_location(button0, file, 212, 6, 4944);
    			attr_dev(div2, "class", "navbar-brand");
    			add_location(div2, file, 200, 4, 4603);
    			attr_dev(span5, "class", "icon is-small");
    			add_location(span5, file, 232, 14, 5617);
    			attr_dev(button1, "class", "button is-small is-primary is-outlined svelte-11r0plj");
    			attr_dev(button1, "title", "Download log");
    			add_location(button1, file, 227, 12, 5448);
    			attr_dev(span6, "class", "icon is-small");
    			add_location(span6, file, 241, 14, 5886);
    			attr_dev(button2, "class", "button is-small is-danger is-outlined svelte-11r0plj");
    			attr_dev(button2, "title", "Clear");
    			add_location(button2, file, 236, 12, 5731);
    			attr_dev(div3, "class", "buttons are-small");
    			add_location(div3, file, 226, 10, 5404);
    			attr_dev(div4, "class", "navbar-item");
    			add_location(div4, file, 225, 8, 5368);
    			attr_dev(div5, "class", "navbar-start");
    			add_location(div5, file, 224, 6, 5333);
    			attr_dev(span7, "class", "icon is-small");
    			add_location(span7, file, 257, 14, 6364);
    			attr_dev(button3, "class", "button is-small is-warning is-outlined svelte-11r0plj");
    			attr_dev(button3, "title", "Toggle graph");
    			toggle_class(button3, "is-light", /*chartOpen*/ ctx[8]);
    			add_location(button3, file, 251, 12, 6154);
    			attr_dev(span8, "class", "icon is-small");
    			add_location(span8, file, 277, 14, 7035);
    			attr_dev(button4, "class", "button is-small is-primary is-outlined svelte-11r0plj");
    			attr_dev(button4, "title", "Auto EOL");
    			toggle_class(button4, "is-light", /*convertEol*/ ctx[10]);
    			add_location(button4, file, 271, 12, 6830);
    			attr_dev(span9, "class", "icon is-small");
    			add_location(span9, file, 287, 14, 7368);
    			attr_dev(button5, "class", "button is-small is-info is-outlined svelte-11r0plj");
    			attr_dev(button5, "title", "Local echo");
    			toggle_class(button5, "is-light", /*localEcho*/ ctx[11]);
    			add_location(button5, file, 281, 12, 7159);
    			attr_dev(div6, "class", "buttons are-small");
    			add_location(div6, file, 250, 10, 6110);
    			attr_dev(div7, "class", "navbar-item");
    			add_location(div7, file, 249, 8, 6074);
    			attr_dev(span10, "class", "icon is-small");
    			add_location(span10, file, 302, 16, 7812);
    			attr_dev(button6, "class", "button is-small svelte-11r0plj");
    			attr_dev(button6, "title", "Reload");
    			button6.disabled = /*connected*/ ctx[6];
    			add_location(button6, file, 296, 14, 7625);
    			attr_dev(p0, "class", "control");
    			add_location(p0, file, 295, 12, 7591);
    			attr_dev(input0, "class", "input is-small port svelte-11r0plj");
    			attr_dev(input0, "list", "ports");
    			input0.disabled = input0_disabled_value = /*busy*/ ctx[5] || /*connected*/ ctx[6];
    			add_location(input0, file, 308, 14, 7990);
    			attr_dev(datalist, "id", "ports");
    			add_location(datalist, file, 314, 14, 8184);
    			attr_dev(div8, "class", "control");
    			add_location(div8, file, 307, 12, 7954);
    			attr_dev(input1, "class", "input is-small baudrate svelte-11r0plj");
    			attr_dev(input1, "type", "text");
    			attr_dev(input1, "placeholder", "Baudrate");
    			input1.disabled = input1_disabled_value = /*busy*/ ctx[5] || /*connected*/ ctx[6];
    			add_location(input1, file, 320, 14, 8384);
    			attr_dev(p1, "class", "control");
    			add_location(p1, file, 319, 12, 8350);
    			attr_dev(button7, "class", "button is-small svelte-11r0plj");
    			button7.disabled = /*busy*/ ctx[5];
    			toggle_class(button7, "is-loading", /*busy*/ ctx[5]);
    			toggle_class(button7, "is-success", !/*connected*/ ctx[6]);
    			toggle_class(button7, "is-danger", /*connected*/ ctx[6]);
    			add_location(button7, file, 329, 14, 8669);
    			attr_dev(p2, "class", "control");
    			add_location(p2, file, 328, 12, 8635);
    			attr_dev(div9, "class", "field has-addons");
    			add_location(div9, file, 294, 10, 7548);
    			attr_dev(div10, "class", "navbar-item");
    			add_location(div10, file, 293, 8, 7512);
    			attr_dev(div11, "class", "navbar-end");
    			add_location(div11, file, 248, 6, 6041);
    			attr_dev(div12, "class", "navbar-menu has-background-dark");
    			toggle_class(div12, "is-active", /*navbarOpen*/ ctx[7]);
    			add_location(div12, file, 223, 4, 5252);
    			attr_dev(nav, "class", "navbar is-dark");
    			add_location(nav, file, 199, 2, 4570);
    			attr_dev(div13, "class", "terminal svelte-11r0plj");
    			add_location(div13, file, 348, 2, 9160);
    			attr_dev(div14, "class", "workspace svelte-11r0plj");
    			add_location(div14, file, 198, 0, 4544);
    		},
    		l: function claim(nodes) {
    			throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
    		},
    		m: function mount(target, anchor) {
    			insert_dev(target, div0, anchor);
    			if (if_block0) if_block0.m(div0, null);
    			insert_dev(target, t0, anchor);
    			insert_dev(target, div14, anchor);
    			append_dev(div14, nav);
    			append_dev(nav, div2);
    			append_dev(div2, div1);
    			append_dev(div1, span1);
    			append_dev(span1, span0);
    			mount_component(terminalicon, span0, null);
    			append_dev(span1, t1);
    			append_dev(div2, t2);
    			append_dev(div2, button0);
    			append_dev(button0, span2);
    			append_dev(button0, t3);
    			append_dev(button0, span3);
    			append_dev(button0, t4);
    			append_dev(button0, span4);
    			append_dev(nav, t5);
    			append_dev(nav, div12);
    			append_dev(div12, div5);
    			append_dev(div5, div4);
    			append_dev(div4, div3);
    			append_dev(div3, button1);
    			append_dev(button1, span5);
    			mount_component(saveicon, span5, null);
    			append_dev(div3, t6);
    			append_dev(div3, button2);
    			append_dev(button2, span6);
    			mount_component(trash2icon, span6, null);
    			append_dev(div12, t7);
    			append_dev(div12, div11);
    			append_dev(div11, div7);
    			append_dev(div7, div6);
    			append_dev(div6, button3);
    			append_dev(button3, span7);
    			mount_component(barchart2icon, span7, null);
    			append_dev(div6, t8);
    			append_dev(div6, button4);
    			append_dev(button4, span8);
    			mount_component(cornerdownlefticon, span8, null);
    			append_dev(div6, t9);
    			append_dev(div6, button5);
    			append_dev(button5, span9);
    			mount_component(repeaticon, span9, null);
    			append_dev(div11, t10);
    			append_dev(div11, div10);
    			append_dev(div10, div9);
    			append_dev(div9, p0);
    			append_dev(p0, button6);
    			append_dev(button6, span10);
    			mount_component(refreshcwicon, span10, null);
    			append_dev(div9, t11);
    			append_dev(div9, div8);
    			append_dev(div8, input0);
    			set_input_value(input0, /*portName*/ ctx[1]);
    			append_dev(div8, t12);
    			append_dev(div8, datalist);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(datalist, null);
    			}

    			append_dev(div9, t13);
    			append_dev(div9, p1);
    			append_dev(p1, input1);
    			set_input_value(input1, /*baudrate*/ ctx[2]);
    			append_dev(div9, t14);
    			append_dev(div9, p2);
    			append_dev(p2, button7);
    			append_dev(button7, t15);
    			append_dev(div14, t16);
    			if (if_block1) if_block1.m(div14, null);
    			append_dev(div14, t17);
    			append_dev(div14, div13);
    			append_dev(div14, t18);
    			if (if_block2) if_block2.m(div14, null);
    			current = true;

    			if (!mounted) {
    				dispose = [
    					listen_dev(button0, "click", /*toggleNavbar*/ ctx[15], false, false, false),
    					listen_dev(button1, "click", /*downloadLog*/ ctx[21], false, false, false),
    					listen_dev(button2, "click", /*clear*/ ctx[20], false, false, false),
    					listen_dev(button3, "click", /*toggleChart*/ ctx[16], false, false, false),
    					listen_dev(button4, "click", /*toggleEol*/ ctx[17], false, false, false),
    					listen_dev(button5, "click", /*toggleLocalEcho*/ ctx[18], false, false, false),
    					listen_dev(button6, "click", /*reloadPorts*/ ctx[13], false, false, false),
    					listen_dev(input0, "input", /*input0_input_handler*/ ctx[22]),
    					listen_dev(input1, "input", /*input1_input_handler*/ ctx[23]),
    					listen_dev(button7, "click", /*toggleConnection*/ ctx[14], false, false, false),
    					action_destroyer(/*term*/ ctx[12].call(null, div13))
    				];

    				mounted = true;
    			}
    		},
    		p: function update(ctx, dirty) {
    			if (/*error*/ ctx[4]) {
    				if (if_block0) {
    					if_block0.p(ctx, dirty);
    				} else {
    					if_block0 = create_if_block_2(ctx);
    					if_block0.c();
    					if_block0.m(div0, null);
    				}
    			} else if (if_block0) {
    				if_block0.d(1);
    				if_block0 = null;
    			}

    			if (dirty[0] & /*connected*/ 64) {
    				toggle_class(span1, "is-danger", /*connected*/ ctx[6]);
    			}

    			if (dirty[0] & /*navbarOpen*/ 128) {
    				toggle_class(button0, "is-active", /*navbarOpen*/ ctx[7]);
    			}

    			if (dirty[0] & /*chartOpen*/ 256) {
    				toggle_class(button3, "is-light", /*chartOpen*/ ctx[8]);
    			}

    			if (dirty[0] & /*convertEol*/ 1024) {
    				toggle_class(button4, "is-light", /*convertEol*/ ctx[10]);
    			}

    			if (dirty[0] & /*localEcho*/ 2048) {
    				toggle_class(button5, "is-light", /*localEcho*/ ctx[11]);
    			}

    			if (!current || dirty[0] & /*connected*/ 64) {
    				prop_dev(button6, "disabled", /*connected*/ ctx[6]);
    			}

    			if (!current || dirty[0] & /*busy, connected*/ 96 && input0_disabled_value !== (input0_disabled_value = /*busy*/ ctx[5] || /*connected*/ ctx[6])) {
    				prop_dev(input0, "disabled", input0_disabled_value);
    			}

    			if (dirty[0] & /*portName*/ 2 && input0.value !== /*portName*/ ctx[1]) {
    				set_input_value(input0, /*portName*/ ctx[1]);
    			}

    			if (dirty[0] & /*ports*/ 8) {
    				each_value = /*ports*/ ctx[3];
    				validate_each_argument(each_value);
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(datalist, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}

    			if (!current || dirty[0] & /*busy, connected*/ 96 && input1_disabled_value !== (input1_disabled_value = /*busy*/ ctx[5] || /*connected*/ ctx[6])) {
    				prop_dev(input1, "disabled", input1_disabled_value);
    			}

    			if (dirty[0] & /*baudrate*/ 4 && input1.value !== /*baudrate*/ ctx[2]) {
    				set_input_value(input1, /*baudrate*/ ctx[2]);
    			}

    			if ((!current || dirty[0] & /*connected*/ 64) && t15_value !== (t15_value = (/*connected*/ ctx[6] ? "Disconnect" : "Connect") + "")) set_data_dev(t15, t15_value);

    			if (!current || dirty[0] & /*busy*/ 32) {
    				prop_dev(button7, "disabled", /*busy*/ ctx[5]);
    			}

    			if (dirty[0] & /*busy*/ 32) {
    				toggle_class(button7, "is-loading", /*busy*/ ctx[5]);
    			}

    			if (dirty[0] & /*connected*/ 64) {
    				toggle_class(button7, "is-success", !/*connected*/ ctx[6]);
    			}

    			if (dirty[0] & /*connected*/ 64) {
    				toggle_class(button7, "is-danger", /*connected*/ ctx[6]);
    			}

    			if (dirty[0] & /*navbarOpen*/ 128) {
    				toggle_class(div12, "is-active", /*navbarOpen*/ ctx[7]);
    			}

    			if (/*chartOpen*/ ctx[8]) {
    				if (if_block1) {
    					if_block1.p(ctx, dirty);

    					if (dirty[0] & /*chartOpen*/ 256) {
    						transition_in(if_block1, 1);
    					}
    				} else {
    					if_block1 = create_if_block_1(ctx);
    					if_block1.c();
    					transition_in(if_block1, 1);
    					if_block1.m(div14, t17);
    				}
    			} else if (if_block1) {
    				group_outros();

    				transition_out(if_block1, 1, 1, () => {
    					if_block1 = null;
    				});

    				check_outros();
    			}

    			if (/*keyboardOpen*/ ctx[9]) {
    				if (if_block2) {
    					if_block2.p(ctx, dirty);

    					if (dirty[0] & /*keyboardOpen*/ 512) {
    						transition_in(if_block2, 1);
    					}
    				} else {
    					if_block2 = create_if_block(ctx);
    					if_block2.c();
    					transition_in(if_block2, 1);
    					if_block2.m(div14, null);
    				}
    			} else if (if_block2) {
    				group_outros();

    				transition_out(if_block2, 1, 1, () => {
    					if_block2 = null;
    				});

    				check_outros();
    			}
    		},
    		i: function intro(local) {
    			if (current) return;
    			transition_in(terminalicon.$$.fragment, local);
    			transition_in(saveicon.$$.fragment, local);
    			transition_in(trash2icon.$$.fragment, local);
    			transition_in(barchart2icon.$$.fragment, local);
    			transition_in(cornerdownlefticon.$$.fragment, local);
    			transition_in(repeaticon.$$.fragment, local);
    			transition_in(refreshcwicon.$$.fragment, local);
    			transition_in(if_block1);
    			transition_in(if_block2);
    			current = true;
    		},
    		o: function outro(local) {
    			transition_out(terminalicon.$$.fragment, local);
    			transition_out(saveicon.$$.fragment, local);
    			transition_out(trash2icon.$$.fragment, local);
    			transition_out(barchart2icon.$$.fragment, local);
    			transition_out(cornerdownlefticon.$$.fragment, local);
    			transition_out(repeaticon.$$.fragment, local);
    			transition_out(refreshcwicon.$$.fragment, local);
    			transition_out(if_block1);
    			transition_out(if_block2);
    			current = false;
    		},
    		d: function destroy(detaching) {
    			if (detaching) detach_dev(div0);
    			if (if_block0) if_block0.d();
    			if (detaching) detach_dev(t0);
    			if (detaching) detach_dev(div14);
    			destroy_component(terminalicon);
    			destroy_component(saveicon);
    			destroy_component(trash2icon);
    			destroy_component(barchart2icon);
    			destroy_component(cornerdownlefticon);
    			destroy_component(repeaticon);
    			destroy_component(refreshcwicon);
    			destroy_each(each_blocks, detaching);
    			if (if_block1) if_block1.d();
    			if (if_block2) if_block2.d();
    			mounted = false;
    			run_all(dispose);
    		}
    	};

    	dispatch_dev("SvelteRegisterBlock", {
    		block,
    		id: create_fragment.name,
    		type: "component",
    		source: "",
    		ctx
    	});

    	return block;
    }

    function instance($$self, $$props, $$invalidate) {
    	let { $$slots: slots = {}, $$scope } = $$props;
    	validate_slots('App', slots, []);
    	const terminal = new xterm$1.Terminal();
    	const fitAddon = new xtermAddonFit_1();
    	terminal.loadAddon(fitAddon);
    	let connection;
    	let chart;
    	let portName;
    	let baudrate = localStorage.getItem("baudrate") || 115200;
    	let ports = [];
    	let error = "";
    	let busy = false;
    	let connected = false;
    	let navbarOpen = false;
    	let chartOpen = false;
    	let keyboardOpen = false;
    	let convertEol = false;
    	let localEcho = false;
    	let decoder = new TextDecoder("utf-8");
    	var encoder = new TextEncoder("utf-8");
    	let log = "";

    	onMount(async () => {
    		connect();
    		window.addEventListener("resize", () => fitAddon.fit(), false);
    		fitAddon.fit();
    	});

    	afterUpdate(() => {
    		terminal.element.style.height = terminal.element.parentNode.clientHeight + "px";
    		fitAddon.fit();
    	});

    	function serialHook(bytes) {
    		terminal.write(bytes);
    		log += decoder.decode(bytes);

    		if (chart) {
    			chart.pushData(bytes);
    		}
    	}

    	function connect() {
    		connection = new WebSocket(`ws://${window.location.host}/ws`);
    		connection.onopen = onOpen;

    		connection.onclose = () => {
    			$$invalidate(6, connected = false);
    			$$invalidate(4, error = "Websocket closed. Reconnecting...");
    			setTimeout(connect, 700);
    		};

    		connection.onmessage = onMessage;

    		terminal.onData(data => {
    			if (convertEol) {
    				data = data.replace(/\r/, "\r\n");
    			}

    			if (localEcho) {
    				serialHook(encoder.encode(data));
    			}

    			connected && connection.send(new Blob([data]));
    		});
    	}

    	function term(node) {
    		terminal.open(node);
    	}

    	async function onMessage({ data }) {
    		if (typeof data === "object") {
    			const reader = new FileReader();

    			reader.addEventListener("loadend", () => {
    				serialHook(new Uint8Array(reader.result));
    			});

    			reader.readAsArrayBuffer(data);
    			return;
    		}

    		const [command, ...params] = data.split(" ");

    		switch (command) {
    			case "OK:":
    				{
    					$$invalidate(6, connected = params[0] === "UP");

    					if (connected) {
    						$$invalidate(7, navbarOpen = false);
    					}

    					$$invalidate(4, error = "");
    					break;
    				}
    			case "ERROR:":
    				{
    					$$invalidate(4, error = params.join(" "));
    					break;
    				}
    			case "LIST:":
    				{
    					$$invalidate(3, ports = params);
    					$$invalidate(1, portName = localStorage.getItem("portName") || params[0]);
    					break;
    				}
    		}

    		$$invalidate(5, busy = false);
    	}

    	function onOpen() {
    		connection.send("STATUS");
    		reloadPorts();
    	}

    	function reloadPorts() {
    		connection.send("LIST");
    	}

    	function toggleConnection() {
    		if (connection.readyState !== 1) {
    			$$invalidate(4, error = "Websocket closed. Reconnecting...");
    			setTimeout(connect, 500);
    			return;
    		}

    		localStorage.setItem("portName", portName);
    		localStorage.setItem("baudrate", baudrate);
    		$$invalidate(5, busy = true);
    		$$invalidate(4, error = "");

    		connected
    		? connection.send("DISCONNECT")
    		: connection.send(`CONNECT ${portName} ${baudrate}`);
    	}

    	function toggleNavbar() {
    		$$invalidate(7, navbarOpen = !navbarOpen);
    	}

    	function toggleChart() {
    		$$invalidate(8, chartOpen = !chartOpen);
    	}

    	function toggleKeyboard() {
    		$$invalidate(9, keyboardOpen = !keyboardOpen);
    	}

    	function toggleEol() {
    		$$invalidate(10, convertEol = !convertEol);
    	}

    	function toggleLocalEcho() {
    		$$invalidate(11, localEcho = !localEcho);
    	}

    	function onKeyboard(message) {
    		if (message.detail) {
    			serialHook(encoder.encode(message.detail));
    		}
    	}

    	function clear() {
    		log = "";
    		decoder = new TextDecoder("utf-8");
    		terminal.reset();
    		chart && chart.clear();
    	}

    	function downloadLog() {
    		const blob = new Blob([log], { type: "text/plain;charset=utf-8;" });
    		const a = document.createElement("a");
    		a.download = `serial-session-${new Date().toISOString()}.log`;
    		a.href = URL.createObjectURL(blob);
    		a.dataset.downloadurl = ["text/plain;charset=utf-8;", a.download, a.href].join(":");
    		a.style.display = "none";
    		document.body.appendChild(a);
    		a.click();
    		document.body.removeChild(a);
    	}

    	const writable_props = [];

    	Object.keys($$props).forEach(key => {
    		if (!~writable_props.indexOf(key) && key.slice(0, 2) !== '$$' && key !== 'slot') console.warn(`<App> was created with unknown prop '${key}'`);
    	});

    	function input0_input_handler() {
    		portName = this.value;
    		$$invalidate(1, portName);
    	}

    	function input1_input_handler() {
    		baudrate = this.value;
    		$$invalidate(2, baudrate);
    	}

    	function chart_1_binding($$value) {
    		binding_callbacks[$$value ? 'unshift' : 'push'](() => {
    			chart = $$value;
    			$$invalidate(0, chart);
    		});
    	}

    	$$self.$capture_state = () => ({
    		onMount,
    		afterUpdate,
    		BarChart2Icon,
    		CornerDownLeftIcon,
    		RefreshCwIcon,
    		RepeatIcon,
    		SaveIcon,
    		TerminalIcon,
    		Trash2Icon,
    		xterm: xterm$2,
    		FitAddon: xtermAddonFit_1,
    		Chart,
    		Keyboard: Keyboard_1,
    		terminal,
    		fitAddon,
    		connection,
    		chart,
    		portName,
    		baudrate,
    		ports,
    		error,
    		busy,
    		connected,
    		navbarOpen,
    		chartOpen,
    		keyboardOpen,
    		convertEol,
    		localEcho,
    		decoder,
    		encoder,
    		log,
    		serialHook,
    		connect,
    		term,
    		onMessage,
    		onOpen,
    		reloadPorts,
    		toggleConnection,
    		toggleNavbar,
    		toggleChart,
    		toggleKeyboard,
    		toggleEol,
    		toggleLocalEcho,
    		onKeyboard,
    		clear,
    		downloadLog
    	});

    	$$self.$inject_state = $$props => {
    		if ('connection' in $$props) connection = $$props.connection;
    		if ('chart' in $$props) $$invalidate(0, chart = $$props.chart);
    		if ('portName' in $$props) $$invalidate(1, portName = $$props.portName);
    		if ('baudrate' in $$props) $$invalidate(2, baudrate = $$props.baudrate);
    		if ('ports' in $$props) $$invalidate(3, ports = $$props.ports);
    		if ('error' in $$props) $$invalidate(4, error = $$props.error);
    		if ('busy' in $$props) $$invalidate(5, busy = $$props.busy);
    		if ('connected' in $$props) $$invalidate(6, connected = $$props.connected);
    		if ('navbarOpen' in $$props) $$invalidate(7, navbarOpen = $$props.navbarOpen);
    		if ('chartOpen' in $$props) $$invalidate(8, chartOpen = $$props.chartOpen);
    		if ('keyboardOpen' in $$props) $$invalidate(9, keyboardOpen = $$props.keyboardOpen);
    		if ('convertEol' in $$props) $$invalidate(10, convertEol = $$props.convertEol);
    		if ('localEcho' in $$props) $$invalidate(11, localEcho = $$props.localEcho);
    		if ('decoder' in $$props) decoder = $$props.decoder;
    		if ('encoder' in $$props) encoder = $$props.encoder;
    		if ('log' in $$props) log = $$props.log;
    	};

    	if ($$props && "$$inject" in $$props) {
    		$$self.$inject_state($$props.$$inject);
    	}

    	return [
    		chart,
    		portName,
    		baudrate,
    		ports,
    		error,
    		busy,
    		connected,
    		navbarOpen,
    		chartOpen,
    		keyboardOpen,
    		convertEol,
    		localEcho,
    		term,
    		reloadPorts,
    		toggleConnection,
    		toggleNavbar,
    		toggleChart,
    		toggleEol,
    		toggleLocalEcho,
    		onKeyboard,
    		clear,
    		downloadLog,
    		input0_input_handler,
    		input1_input_handler,
    		chart_1_binding
    	];
    }

    class App extends SvelteComponentDev {
    	constructor(options) {
    		super(options);
    		init(this, options, instance, create_fragment, safe_not_equal, {}, null, [-1, -1]);

    		dispatch_dev("SvelteRegisterComponent", {
    			component: this,
    			tagName: "App",
    			options,
    			id: create_fragment.name
    		});
    	}
    }

    const app = new App({ target: document.body });

    return app;

})();
//# sourceMappingURL=wterm.js.map
