declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export type MarkedTerminalOptions = {
    emoji?: boolean;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
    tab?: number;
    unescape?: boolean;
    width?: number;
  };

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
