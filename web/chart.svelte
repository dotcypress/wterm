<script>
  import Chart from "chart.js";
  import "chartjs-plugin-streaming";

  export let maxPoints = 1000;
  let chart;

  export function clear() {
    for (const set of chart.data.datasets) {
      set.data = [];
    }
    chart.update({ duration: 0 });
  }

  export function addPoints(points) {
    for (let index = 0; index < points.length; index++) {
      const dataset = chart.data.datasets[index]
      dataset && dataset.data.push(points[index]);
    }
  }

  function graph(node) {
    const ctx = node.getContext("2d");
    node.width = node.parentElement.clientWidth;
    const cfg = {
      data: {
        datasets: [
          {
            type: "line",
            label: "First",
            borderColor: "hsl(48, 100%, 67%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 1,
            lineTension: 0.05
          },
          {
            type: "line",
            label: "Second",
            borderColor: "hsl(204, 86%, 53%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 1,
            lineTension: 0.05
          },
          {
            type: "line",
            label: "Third",
            borderColor: "hsl(141, 71%, 48%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 1,
            lineTension: 0.05
          },
          {
            type: "line",
            label: "Fourth",
            borderColor: "hsl(348, 100%, 61%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 1,
            lineTension: 0.05
          },
          {
            type: "line",
            label: "Fifth",
            borderColor: "hsl(0, 0%, 96%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 1,
            lineTension: 0.05
          }
        ]
      },
      options: {
        responsive: false,
        legend: {
          display: false,
          position: "bottom"
        },
        layout: {
          padding: { top: 10, right: 0, bottom: 10, left: 0 }
        },
        animation: {
          duration: 0
        },
        scales: {
          xAxes: [
            {
              display: false,
              type: "realtime",
              offset: false,
              realtime: {
                duration: maxPoints * 60,
                delay: 100,
                pause: false,
              },
              ticks: {
                enabled: false
              }
            }
          ],
          yAxes: [
            {
              position: "right",
              gridLines: {
                drawBorder: false,
                drawOnChartArea: false
              },
              scaleLabel: {
                display: true
              }
            }
          ]
        },
        plugins: {
          streaming: {
            frameRate: 30
          }
        },
        tooltips: {
          intersect: false,
          mode: "index"
        }
      }
    };

    chart = new Chart(ctx, cfg);
  }
</script>

<style>
  canvas {
    border-bottom: 1px dashed hsl(0, 0%, 17%);
  }
</style>

<div>
  <canvas height="200" width="100" use:graph />
</div>
