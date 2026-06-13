import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

export default mount(App, {
  // biome-ignore lint/style/noNonNullAssertion: the #app element is in index.html
  target: document.getElementById("app")!,
});
