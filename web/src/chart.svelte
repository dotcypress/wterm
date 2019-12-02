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
    limitFPS: 20,
    grid: {
      strokeStyle: "#2b2b2b",
      borderVisible: false,
      millisPerLine: 5000,
      verticalSections: 4
    },
    tooltip: true
  });
  const series = [];

  for (let index = 0; index < 10; index++) {
    const ds = new TimeSeries();
    series.push(ds);
    chart.addTimeSeries(ds, {
      strokeStyle: CHART_COLORS[index],
      lineWidth: 2
    });
  }

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

  function extractPoints() {
    for (const line of readLine()) {
      const points = line
        .split(/[^.\w]/)
        .map(parseFloat)
        .filter(Boolean);
      for (let index = 0; index < points.length; index++) {
        const ds = series[index];
        ds && ds.append(Date.now(), points[index]);
      }
    }
  }

  function graph(node) {
    chart.streamTo(node, 500);
    node.width = node.parentElement.clientWidth;
  }
</script>

<style>
  canvas {
    border-bottom: 1px dashed #2b2b2b;
  }
  :global(div.smoothie-chart-tooltip) {
    background: #363636;
    padding: 1em;
    margin-top: 20px;
    color: white;
    font-size: 10px;
    pointer-events: none;
  }
</style>

<div class="graph-pane">
  <canvas height="250" width="400" use:graph />
</div>
