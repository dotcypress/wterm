<script>
  import Smoothie from "smoothie";
  const CHART_COLORS = [
    "hsl(48, 100%, 67%)",
    "hsl(204, 86%, 53%)",
    "hsl(141, 71%, 48%)",
    "hsl(348, 100%, 61%)",
    "hsl(0, 0%, 96%)"
  ];

  const { TimeSeries, SmoothieChart } = Smoothie;
  const chart = new SmoothieChart({
    millisPerPixel: 100,
    limitFPS:15,
    grid: {
      strokeStyle: "hsl(0, 0%, 17%)",
      borderVisible: false,
      millisPerLine: 10000,
      verticalSections: 3
    },
    tooltip: true
  });
  const series = [];

  for (let index = 0; index < 5; index++) {
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
  }

  export function addPoints(points) {
    for (let index = 0; index < points.length; index++) {
      const ds = series[index];
      ds && ds.append(Date.now(), points[index]);
    }
  }

  function graph(node) {
    chart.streamTo(node, 500);
    node.width = node.parentElement.clientWidth;
  }
</script>

<style>
  canvas {
    border-bottom: 1px dashed hsl(0, 0%, 17%);
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
  <canvas height="200" width="200" use:graph />
</div>
