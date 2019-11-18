<script>
  import { onDestroy } from "svelte";
  import Chart from "chart.js";
  import "chartjs-plugin-streaming";

  let chart;
  let speed = 60;

  onDestroy(() => {
    chart.destroy();
  });

  export function clear() {
    for (const set of chart.data.datasets) {
      set.data = [];
    }
    chart.update({ preservation: true });
  }

  $: {
    if (chart) {
      chart.options.scales.xAxes[0].realtime.duration = parseInt(speed) * 1000;
    }
  }

  export function addPoints(points) {
    for (let index = 0; index < points.length; index++) {
      const dataset = chart.data.datasets[index];
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
            pointRadius: 0,
            lineTension: 0.07
          },
          {
            type: "line",
            label: "Second",
            borderColor: "hsl(204, 86%, 53%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 0,
            lineTension: 0.07
          },
          {
            type: "line",
            label: "Third",
            borderColor: "hsl(141, 71%, 48%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 0,
            lineTension: 0.07
          },
          {
            type: "line",
            label: "Fourth",
            borderColor: "hsl(348, 100%, 61%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 0,
            lineTension: 0.07
          },
          {
            type: "line",
            label: "Fifth",
            borderColor: "hsl(0, 0%, 96%)",
            fill: false,
            spanGaps: true,
            borderWidth: 1,
            pointRadius: 0,
            lineTension: 0.07
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
                duration: speed,
                delay: 100,
                pause: false
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
  .graph-pane {
    position: relative;
  }
  .settings {
    position: absolute;
    left: 10px;
    bottom: 10px;
  }
  canvas {
    border-bottom: 1px dashed hsl(0, 0%, 17%);
  }
</style>

<div class="graph-pane">
  <div class="settings">
    <div class="field">
      <div class="control">
        <div class="select is-small is-warning">
          <select
            class="has-text-warning has-background-black-bis"
            bind:value={speed}>
            <option value="30">History: 30 sec</option>
            <option value="60">History: 1 min</option>
            <option value="300">History: 5 min</option>
            <option value="900">History: 15 min</option>
          </select>
        </div>
      </div>
    </div>
  </div>
  <canvas height="200" width="100" use:graph />
</div>
