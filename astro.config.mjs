// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://dcwcost.com',
  output: 'static',
  integrations: [
    sitemap({
      // The team intranet is internal. Keep it out of the public sitemap —
      // see also the noindex meta tag in IntranetLayout.astro and the
      // Disallow rule in public/robots.txt.
      filter: (page) => !page.includes('/teamintranet'),
    }),
  ],
  build: {
    // Emit static files to ./dist (Astro default) for Netlify to publish.
    format: 'directory',
  },
});
