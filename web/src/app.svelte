<script>
  import "xterm/css/xterm.css";
  import "bulma/css/bulma.min.css";
  import { onMount, afterUpdate } from "svelte";
  import {
    TerminalIcon,
    Trash2Icon,
    RefreshCwIcon,
    BarChart2Icon,
    SaveIcon,
    CornerDownLeftIcon
  } from "svelte-feather-icons";
  import * as xterm from "xterm";
  import { FitAddon } from "xterm-addon-fit";
  import Chart from "./chart.svelte";

  const terminal = new xterm.default.Terminal();
  const fitAddon = new FitAddon();
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
  let convertEol = false;
  let decoder = new TextDecoder("utf-8");
  let log = "";

  onMount(async () => {
    connect();
    window.addEventListener("resize", () => fitAddon.fit(), false);
    fitAddon.fit();
  });

  afterUpdate(() => {
    terminal.element.style.height =
      terminal.element.parentNode.clientHeight + "px";
    fitAddon.fit();
  });

  function connect() {
    connection = new WebSocket(`ws://${window.location.host}/ws`);
    connection.onopen = onOpen;
    connection.onclose = () => {
      connected = false;
      error = "Websocket closed. Reconnecting...";
      setTimeout(connect, 700);
    };
    connection.onmessage = onMessage;
    terminal.onData(data => {
      if (convertEol) {
        data = data.replace(/\r/, "\r\n");
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
        const bytes = new Uint8Array(reader.result);
        serialHook(bytes);
        terminal.write(bytes);
        log += decoder.decode(bytes);
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
        ports = params;
        portName = localStorage.getItem("portName") || params[0];
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
      error = "Websocket closed. Reconnecting...";
      setTimeout(connect, 700);
      return;
    }
    localStorage.setItem("portName", portName);
    localStorage.setItem("baudrate", baudrate);
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

  function toggleEol() {
    convertEol = !convertEol;
  }

  function clear() {
    log = "";
    decoder = new TextDecoder("utf-8");
    terminal.reset();
    chart && chart.clear();
  }

  function downloadLog() {
    const blob = new Blob([log], {
      type: "text/plain;charset=utf-8;"
    });

    const a = document.createElement("a");
    a.download = `serial-session-${new Date().toISOString()}.log`;
    a.href = URL.createObjectURL(blob);
    a.dataset.downloadurl = [
      "text/plain;charset=utf-8;",
      a.download,
      a.href
    ].join(":");
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function serialHook(buffer) {
    chart && chart.pushData(buffer);
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
    padding: 1em;
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
  .workspace .navbar .navbar-item input.port {
    min-width: 200px;
  }
  .workspace .navbar .navbar-item input.baudrate {
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
              class="button is-small is-primary is-outlined"
              title="Download log"
              on:click={downloadLog}>
              <span class="icon is-small">
                <SaveIcon />
              </span>
            </button>
            <button
              class="button is-small is-danger is-outlined"
              title="Clear"
              on:click={clear}>
              <span class="icon is-small">
                <Trash2Icon />
              </span>
            </button>
          </div>
        </div>
      </div>
      <div class="navbar-end">
        <div class="navbar-item">
          <div class="buttons are-small">
            <button
              class="button is-small is-warning is-outlined"
              title="Toggle graph"
              class:is-light={chartOpen}
              on:click={toggleChart}>
              <span class="icon is-small">
                <BarChart2Icon />
              </span>
            </button>
            <button
              class="button is-small is-primary is-outlined"
              title="Auto EOL"
              class:is-light={convertEol}
              on:click={toggleEol}>
              <span class="icon is-small">
                <CornerDownLeftIcon />
              </span>
            </button>
          </div>
        </div>
        <div class="navbar-item">
          <div class="field has-addons">
            <p class="control">
              <button
                class="button is-small"
                title="Reload"
                disabled={connected}
                on:click={reloadPorts}>
                <span class="icon is-small">
                  <RefreshCwIcon />
                </span>
              </button>
            </p>
            <div class="control">
                <input class="input is-small port"
                  list="ports"
                  bind:value={portName}
                  disabled={busy || connected}>
                <datalist id="ports">
                  {#each ports as port}
                    <option value={port}>
                  {/each}
                </datalist>
            </div>
            <p class="control">
              <input
                class="input is-small baudrate"
                type="text"
                placeholder="Baudrate"
                bind:value={baudrate}
                disabled={busy || connected} />
            </p>
            <p class="control">
              <button
                class="button is-small"
                class:is-loading={busy}
                class:is-success={!connected}
                class:is-danger={connected}
                disabled={busy}
                on:click={toggleConnection}>
                {connected ? 'Disconnect' : 'Connect'}
              </button>
            </p>
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
