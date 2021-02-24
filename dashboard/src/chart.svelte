<script>
  import Smoothie from "smoothie";
  import { SettingsIcon } from "svelte-feather-icons";

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

  const DefaultExtractRegExp = "[.\\d]+";
  let pointExtractRegEx = new RegExp(DefaultExtractRegExp, "gi");
  let regExpError = null;
  let decoder = new TextDecoder("utf-8");
  let accumulator = "";
  let settingsOpen = false;
  let speed = 2;

  const { TimeSeries, SmoothieChart } = Smoothie;
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

  $: {
    chart.options.grid.millisPerLine = CHART_SPEEDS[speed].value * 100;
    chart.options.millisPerPixel = CHART_SPEEDS[speed].value;
  }

  const series = [];
  for (let index = 0; index < LEGEND.colors.length; index++) {
    const ds = new TimeSeries();
    series.push(ds);
    chart.addTimeSeries(ds, {
      strokeStyle: LEGEND.colors[index],
      lineWidth: LEGEND.lineWidth
    });
  }

  export function clear() {
    for (const ds of series) {
      ds.clear();
    }
    decoder = new TextDecoder("utf-8");
    accumulator = "";
  }

  export function pushData(buffer) {
    accumulator += decoder.decode(buffer, { stream: true });
    for (const line of readLine()) {
      const points = [...line.matchAll(pointExtractRegEx)]
        .map(match => {
          if (match.groups) {
            return Object.entries(match.groups)
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(entry => entry[1]);
          }
          return match.length == 1 ? [match[0]] : match.slice(1);
        })
        .flatMap(x => x)
        .map(x => parseFloat(x))
        .filter(Boolean);
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
    settingsOpen = true;
  }

  function closeSettings() {
    settingsOpen = false;
  }

  function updateRegExp(ev) {
    try {
      pointExtractRegEx = new RegExp(
        ev.target.value || DefaultExtractRegExp,
        "gi"
      );
      regExpError = null;
    } catch (err) {
      console.log(err)
      regExpError = err.message;
    }
  }

  function graph(node) {
    chart.streamTo(node, 300);
    node.width = node.parentElement.clientWidth;
  }
</script>

<style>
  canvas {
    border-bottom: 1px dashed #202020;
  }
  :global(div.smoothie-chart-tooltip) {
    background: #363636;
    padding: 1em;
    margin-top: 20px;
    color: white;
    font-size: 10px;
    pointer-events: none;
  }
  .graph-pane {
    position: relative;
  }
  .graph-pane .button {
    position: absolute;
    left: 8px;
    top: 8px;
  }
  .modal-background {
    background-color: rgba(10, 10, 10, 0.4);
  }
  .modal-card input {
    font-family: "Courier New", Courier, monospace;
  }
</style>

<div class="graph-pane">
  <canvas height="250" width="400" use:graph />
  <button
    class="button is-small is-primary is-outlined"
    title="Graph Settings"
    on:click={openSettings}>
    <span class="icon is-small">
      <SettingsIcon />
    </span>
  </button>
  <div class="modal" class:is-active={settingsOpen}>
    <div class="modal-background" />
    <div class="modal-card">
      <header class="modal-card-head">
        <p class="modal-card-title">Graph Settings</p>
        <button class="delete" aria-label="close" on:click={closeSettings} />
      </header>
      <section class="modal-card-body">
        <div class="field is-horizontal">
          <div class="field-label is-small">
            <label class="label">Scroll Speed</label>
          </div>
          <div class="field-body">
            <div class="field">
              <div class="control">
                <div class="select is-fullwidth">
                  <select bind:value={speed}>
                    {#each CHART_SPEEDS as speed, i}
                      <option value={i}>{speed.name}</option>
                    {/each}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="field is-horizontal">
          <div class="field-label is-small">
            <label class="label">Points RegExp</label>
          </div>
          <div class="field-body">
            <div class="field">
              <div class="control">
                <input
                  class="input"
                  type="text"
                  class:is-danger={regExpError}
                  on:change={updateRegExp}
                  value={pointExtractRegEx.source} />
              </div>
              {#if regExpError}
                <p class="help is-danger">{regExpError}</p>
              {/if}
            </div>
          </div>
        </div>
      </section>
      <footer class="modal-card-foot" />
    </div>
  </div>
</div>
