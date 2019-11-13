import svelte from 'rollup-plugin-svelte'
import postcss from 'rollup-plugin-postcss'
import resolve from 'rollup-plugin-node-resolve'
import commonjs from 'rollup-plugin-commonjs'
import { terser } from 'rollup-plugin-terser'

const production = !process.env.ROLLUP_WATCH

export default {
  input: 'index.js',
  output: {
    sourcemap: !production,
    format: 'iife',
    name: 'wte',
    file: '../static/wterm.js'
  },
  external: [],
  plugins: [
    svelte({
      dev: !production,
      css: (css) => css.write('../static/wterm.css', false)
    }),
    postcss(),
    resolve({ browser: true }),
    commonjs(),
    production && terser()
  ]
}
