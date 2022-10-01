<script>
  import { createEventDispatcher } from "svelte";
  import Keyboard from "svelte-keyboard";

  const dispatch = createEventDispatcher();

  const onKeydown = (event) => {
    console.log(event.detail);
    if (event.detail === "wterm:open-settings") {
      settingsOpen = true;
    }
    dispatch("message", event.detail);
  };

  let settingsOpen = false;

  function closeSettings() {
    settingsOpen = false;
  }
</script>

<div class="kbrd-pane">
  <div class="modal" class:is-active={settingsOpen}>
    <div class="modal-background" />
    <div class="modal-card">
      <header class="modal-card-head">
        <p class="modal-card-title">Keyboard Settings</p>
        <button class="delete" aria-label="close" on:click={closeSettings} />
      </header>
      <section class="modal-card-body">
        <div class="field is-horizontal" />
      </section>
      <footer class="modal-card-foot" />
    </div>
  </div>
</div>

<Keyboard
  on:keydown={onKeydown}
  --flex="0 auto"
  custom={[
    { row: 0, value: "s" },
    { row: 0, value: "v" },
    { row: 0, value: "e" },
    { row: 0, value: "l" },
    { row: 0, value: "t" },
    { row: 0, value: "e" },
    { row: 1, value: "k" },
    { row: 1, value: "e" },
    { row: 1, value: "y" },
    { row: 1, value: "b" },
    { row: 1, value: "o" },
    { row: 1, value: "a" },
    { row: 1, value: "r" },
    { row: 1, value: "d" },
  ]}
/>

<style>
  .kbrd-pane {
    position: relative;
  }
  .modal-background {
    background-color: rgba(10, 10, 10, 0.4);
  }
</style>
