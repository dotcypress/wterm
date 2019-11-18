<script>
  import "xterm/css/xterm.css";
  import "bulma/css/bulma.min.css";
  import { onMount, afterUpdate } from "svelte";
  import {
    TerminalIcon,
    Trash2Icon,
    RefreshCwIcon,
    BarChart2Icon
  } from "svelte-feather-icons";
  import * as xterm from "xterm";
  import { FitAddon } from "xterm-addon-fit";
  import Chart from "./chart.svelte";

  const connection = new WebSocket(`ws://${window.location.host}/ws`);
  const terminal = new xterm.default.Terminal();
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  let chart;
  let baudrate = 19200;
  let portName;
  let ports = [];
  let error = "";
  let busy = false;
  let connected = false;
  let navbarOpen = false;
  let chartOpen = false;

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

  afterUpdate(() => {
    terminal.element.style.height =
      terminal.element.parentNode.clientHeight + "px";
    fitAddon.fit();
  });

  function term(node) {
    terminal.open(node);
  }

  async function onMessage({ data }) {
    if (typeof data === "object") {
      const reader = new FileReader();
      reader.addEventListener("loadend", () => {
        const bytes = new Uint8Array(reader.result);
        serialHook(bytes);
        terminal.write(bytes);
      });
      reader.readAsArrayBuffer(data);
      return;
    }
    const [command, ...params] = data.split(" ");
    switch (command) {
      case "OK:": {
        connected = params[0] === "UP";
        if (connected) {
          navbarOpen = false;
        }
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
    reloadPorts();
  }

  function reloadPorts() {
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

  function toggleNavbar() {
    navbarOpen = !navbarOpen;
  }

  function toggleChart() {
    chartOpen = !chartOpen;
  }

  function clear() {
    terminal.clear();
    chart.clear();
  }

  function extractPoints(line) {
    return line
      .split(/[^.\w]/)
      .filter(val => val !== "")
      .map(group => ({ t: Date.now(), y: parseFloat(group) }));
  }

  function serialHook(buffer) {
    if (!chart) {
      return;
    }
    new TextDecoder("utf-8")
      .decode(buffer)
      .split("\n")
      .map(extractPoints)
      .map(points => chart.addPoints(points));
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
    flex-direction: column;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .workspace > .terminal {
    flex: 1;
    overflow: hidden;
  }
  .workspace .navbar button,
  .workspace .navbar button:focus {
    outline: none;
    border: none;
  }
  .workspace .navbar .navbar-item input {
    max-width: 62px;
  }
</style>

<div class="notification-container">
  {#if error}
    <div class="notification is-danger">{error}</div>
  {/if}
</div>

<div class="workspace">
  <nav class="navbar is-dark">
    <div class="navbar-brand">
      <div class="navbar-item">
        <span
          class="tag is-info is-family-code is-size-6 has-text-weight-bold"
          class:is-danger={connected}>
          <span class="icon is-small">
            <TerminalIcon />
          </span>
          &nbsp; wterm
        </span>
      </div>
      <button
        class="navbar-burger burger has-background-dark"
        aria-hidden="true"
        class:is-active={navbarOpen}
        on:click={toggleNavbar}>
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>
    </div>
    <div class="navbar-menu has-background-dark" class:is-active={navbarOpen}>
      <div class="navbar-start">
        <div class="navbar-item">
          <div class="buttons are-small">
            <button
              class="button is-small is-warning"
              title="Show graph"
              class:is-active={chartOpen}
              class:is-outlined={!chartOpen}
              on:click={toggleChart}>
              <span class="icon is-small">
                <BarChart2Icon />
              </span>
            </button>
          </div>
        </div>
      </div>
      <div class="navbar-end">
        <div class="navbar-item">
          <div class="field has-addons">
            <p class="control">
              <button
                class="button is-small"
                title="Reload"
                on:click={reloadPorts}>
                <span class="icon is-small">
                  <RefreshCwIcon />
                </span>
              </button>
            </p>
            <div class="control">
              <div class="select is-small">
                <select bind:value={portName} disabled={busy || connected}>
                  {#each ports as port}
                    <option value={port}>{port}</option>
                  {/each}
                </select>
              </div>
            </div>
            <p class="control">
              <input
                class="input is-small"
                type="text"
                placeholder="Baudrate"
                bind:value={baudrate}
                disabled={busy || connected} />
            </p>
            <p class="control">
              <button
                class="button is-small"
                class:is-loading={busy}
                class:is-primary={!connected}
                class:is-danger={connected}
                disabled={busy}
                on:click={toggleConnection}>
                {connected ? 'Disconnect' : 'Connect'}
              </button>
            </p>
          </div>
        </div>
        <div class="navbar-item">
          <div class="buttons are-small">
            <button
              class="button is-danger is-small is-light"
              title="Clear"
              on:click={clear}>
              <span class="icon is-small">
                <Trash2Icon />
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </nav>
  {#if chartOpen}
    <Chart bind:this={chart} />
  {/if}
  <div class="terminal" use:term />
</div>
