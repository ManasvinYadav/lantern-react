import { defineConfig } from 'jsrepo';

export default defineConfig({
    // configure where stuff comes from here
    registries: ['https://reactbits.dev/r'],
    // configure where stuff goes here
    paths: {
        component: './src/components',
    },
});