<script>
  import "xterm/css/xterm.css";
  import * as xterm from "xterm";
  import { FitAddon } from "xterm-addon-fit";
  import { onMount, createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();

  const terminal = new xterm.default.Terminal();
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  onMount(async () => {
    terminal.onData(data => dispatch("data", new Blob([data])));
    window.addEventListener('resize', () => fitAddon.fit(), false)
    fitAddon.fit();
  });

  export function write(data) {
    terminal.write(data);
  }
  
  export function clear() {
    terminal.clear();
  }

  function term(node) {
    terminal.open(node);
  }
</script>

<div use:term />
