// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import netlify from '@astrojs/netlify';

// https://astro.build/config
export default defineConfig({
  site: 'https://dcwcost.com',
  // Marketing pages stay prerendered exactly as before. The adapter only
  // enables on-demand rendering for the routes that opt out with
  // `export const prerender = false` — today that is /teamintranet/*, which
  // needs a session on every request.
  output: 'static',
  adapter: netlify(),
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
