/**
 * Zero-overhead no-op stub for Mermaid in standalone WebUI.
 * Eliminates elkjs (1.4MB), cytoscape (425KB), and d3 from the client bundle.
 */
export default {
  initialize: () => {},
  render: async (id: string, _source: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 40" width="320" height="40" id="${id}"><rect width="320" height="40" rx="6" fill="#18181b"/><text x="16" y="24" fill="#a1a1aa" font-family="system-ui, sans-serif" font-size="12">Mermaid preview disabled (minimal bundle)</text></svg>`,
  }),
};
