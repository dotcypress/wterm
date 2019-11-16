<script>
  import "bulma/css/bulma.css";
  import "xterm/css/xterm.css";
  import { onMount, createEventDispatcher } from "svelte";
  import * as xterm from "xterm";
  import { FitAddon } from "xterm-addon-fit";

  const connection = new WebSocket(`ws://${window.location.host}/ws`);
  const terminal = new xterm.default.Terminal();
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  let baudrate = 19200;
  let portName;
  let ports = [];
  let error = "";
  let busy = false;
  let connected = false;

  onMount(async () => {
    connection.onopen = onOpen;
    connection.onclose = () => {
      connected = false;
      error = "";
    };
    connection.onmessage = onMessage;
    terminal.onData(data => connection.send(new Blob([data])));
    window.addEventListener("resize", () => fitAddon.fit(), false);
    fitAddon.fit();
  });

  function term(node) {
    terminal.open(node);
  }

  async function onMessage({ data }) {
    if (typeof data === "object") {
      var buffer = await data.arrayBuffer();
      terminal.write(new Uint8Array(buffer));
      return;
    }
    const [command, ...params] = data.split(" ");
    switch (command) {
      case "OK:": {
        connected = params[0] === "UP";
        error = "";
        break;
      }
      case "ERROR:": {
        error = params.join(" ");
        break;
      }
      case "LIST:": {
        portName = params[0];
        ports = params;
        break;
      }
    }
    busy = false;
  }

  function onOpen() {
    connection.send("STATUS");
    connection.send("LIST");
  }

  function toggleConnection() {
    if (connection.readyState !== 1) {
      error = "Websocket disconnected";
      return;
    }
    busy = true;
    error = "";
    connected
      ? connection.send("DISCONNECT")
      : connection.send(`CONNECT ${portName} ${baudrate}`);
  }
</script>

<style>
  :global(html),
  :global(body) {
    padding: 0;
    margin: 0;
    min-height: 100%;
    background-color: black !important;
  }
  .notification-container {
    position: absolute;
    z-index: 1;
    bottom: 0;
    right: 0;
    padding: 1rem;
  }
  .workspace {
    display: flex;
    position: absolute;
    top: 52px;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .workspace > div {
    flex: 1;
  }
</style>

<div class="notification-container">
  {#if error}
    <div class="notification is-danger">{error}</div>
  {/if}
</div>

<nav class="navbar is-dark is-fixed-top">
  <div class="navbar-menu is-active has-background-dark">
    <div class="navbar-start">
      <div class="navbar-item has-text-danger">
        <span
          class="tag is-info is-light is-family-code is-size-6
          has-text-weight-bold">
          wterm
        </span>
      </div>
    </div>
    <div class="navbar-end">
      <div class="navbar-item">
        <div class="select is-small is-fullwidth">
          <select bind:value={portName} disabled={busy || connected}>
            {#each ports as port}
              <option value={port}>{port}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="navbar-item">
        <input
          class="input is-small"
          type="text"
          placeholder="Baudrate"
          bind:value={baudrate}
          disabled={busy || connected} />
      </div>

      <div class="navbar-item">
        <div class="buttons">
          <button
            class="button is-small"
            class:is-loading={busy}
            class:is-primary={!connected}
            class:is-danger={connected}
            disabled={busy}
            on:click={toggleConnection}>
            {connected ? 'Disconnect' : 'Connect'}
          </button>
          <button
            class="button is-light is-small"
            on:click={() => terminal.clear()}>
            Clear
          </button>
        </div>
      </div>
    </div>
  </div>
</nav>
<div class="workspace">
  <div use:term />
</div>
