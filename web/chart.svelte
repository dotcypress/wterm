<script>
  import Chart from "chart.js";

  export let maxPoints = 100;
  let chart;

  export function clear() {
    chart.data.datasets[0].data = [];
    chart.update({ duration: 0 });
  }

  export function addPoint(point) {
    const data = chart.data.datasets[0].data;
    data.push(point);
    while (data.length > maxPoints) {
      data.shift();
    }
    chart.update({
      lazy: true,
      duration: 100,
      easing: "linear"
    });
  }

  function graph(node) {
    const ctx = node.getContext("2d");
    const color = Chart.helpers.color;
    const cfg = {
      data: {
        datasets: [
          {
            type: "line",
            label: "",
            borderColor: "hsl(48, 100%, 67%)",
            fill: false,
            borderWidth: 1,
            pointRadius: 0,
            lineTension: 0.05
          }
        ]
      },
      options: {
        legend: {
          display: false
        },
        animation: {
          duration: 0
        },
        scales: {
          xAxes: [
            {
              type: "time",
              distribution: "series",
              display: false,
              offset: false,
              ticks: {
                major: {
                  enabled: true
                },
                source: "data",
                autoSkip: true,
                autoSkipPadding: 75,
                maxRotation: 0,
                sampleSize: 100
              }
            }
          ],
          yAxes: [
            {
              gridLines: {
                drawBorder: false
              },
              scaleLabel: {
                display: true
              }
            }
          ]
        },
        tooltips: {
          intersect: false,
          mode: "index"
        }
      }
    };

    chart = new Chart(ctx, cfg);
    window.chart = chart;
  }
</script>

<style>
  canvas {
    border-bottom: 1px solid hsl(0, 0%, 29%);
  }
</style>

<canvas height="200" use:graph />
