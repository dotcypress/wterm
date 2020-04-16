<script>
  import Smoothie from "smoothie";

  const CHART_SPEEDS = [
    { name: "Slow", value: 333 },
    { name: "Moderate", value: 100 },
    { name: "Normal", value: 50 },
    { name: "Quick", value: 25 },
    { name: "Fast", value: 10 },
    { name: "Brief", value: 5 }
  ];

  const CHART_COLORS = [
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
  ];

  let speed = 2;
  let decoder = new TextDecoder("utf-8");
  let accumulator = "";

  const { TimeSeries, SmoothieChart } = Smoothie;
  const chart = new SmoothieChart({
    millisPerPixel: CHART_SPEEDS[speed].value,
    limitFPS: 40,
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
  for (let index = 0; index < 10; index++) {
    const ds = new TimeSeries();
    series.push(ds);
    chart.addTimeSeries(ds, {
      strokeStyle: CHART_COLORS[index],
      lineWidth: 2
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
    extractPoints();
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

  function extractPoints() {
    for (const line of readLine()) {
      const points = line
        .split(/[^.\w]/)
        .map(parseFloat)
        .filter(Boolean);
      for (let index = 0; index < points.length; index++) {
        pushPoints(index, points[index]);
      }
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
  .graph-pane .select {
    position: absolute;
    left: 8px;
    bottom: 16px;
  }
</style>

<div class="graph-pane">
  <canvas height="250" width="400" use:graph />
  <div class="select is-small">
    <select bind:value={speed}>
      {#each CHART_SPEEDS as speed, i}
        <option value={i}>{speed.name}</option>
      {/each}
    </select>
  </div>
</div>
