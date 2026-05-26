import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import McpVersionPill from "./components/McpVersionPill.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "nav-bar-content-after": () => h(McpVersionPill),
      "layout-bottom": () => h(McpVersionPill, { placement: "footer" }),
    }),
};
