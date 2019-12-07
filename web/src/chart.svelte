<script>
  import Smoothie from "smoothie";
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

  const { TimeSeries, SmoothieChart } = Smoothie;
  const chart = new SmoothieChart({
    millisPerPixel: 50,
    grid: {
      strokeStyle: "#202020",
      borderVisible: false,
      millisPerLine: 5000,
      verticalSections: 4,
      sharpLines: true
    },
    tooltip: true
  });

  $: chart.options.millisPerPixel = (7 - speed) * 15 + 5;

  const series = [];
  for (let index = 0; index < 10; index++) {
    const ds = new TimeSeries();
    series.push(ds);
    chart.addTimeSeries(ds, {
      strokeStyle: CHART_COLORS[index],
      lineWidth: 2
    });
  }

  let speed = 4;
  let decoder = new TextDecoder("utf-8");
  let accumulator = "";

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

  function pushPoints(index, point) {
    const ds = series[index];
    ds && ds.append(Date.now(), point);
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
      <option value={1}>Speed: 1</option>
      <option value={2}>Speed: 2</option>
      <option value={3}>Speed: 3</option>
      <option value={4}>Speed: 4</option>
      <option value={5}>Speed: 5</option>
      <option value={6}>Speed: 6</option>
      <option value={7}>Speed: 7</option>
    </select>
  </div>
</div>
