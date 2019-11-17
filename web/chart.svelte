<script>
  import Chart from "chart.js";
  import "chartjs-plugin-streaming";

  export let maxPoints = 1000;
  let chart;

  export function clear() {
    for (const set of chart.data.datasets) {
      set.data = []
    }
    chart.update({ duration: 0 });
  }

  export function addPoints(points) {
    for (let index = 0; index < points.length; index++) {
      const data = chart.data.datasets[index].data;
      data.push(points[index]);
      while (data.length > maxPoints) {
        data.shift();
      }
    }

    chart.update({
      lazy: true,
      preservation: true,
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
        legend: {
          display: false,
          position: "bottom"
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
                duration: 1000 * 60,
                delay: 500,
                pause: false,
                ttl: undefined
              },
              ticks: {
                enabled: false,
                major: {
                  enabled: false
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
              position: "right",
              gridLines: {
                drawBorder: true
              },
              scaleLabel: {
                display: true
              }
            }
          ]
        },
        plugins: {
          streaming: {
            frameRate: 20
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

<canvas height="200" use:graph />
