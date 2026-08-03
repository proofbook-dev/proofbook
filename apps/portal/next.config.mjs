/** @type {import('next').NextConfig} */
export default {
  // Workspace packages ship TypeScript sources; Next transpiles them.
  transpilePackages: ["@proofbook/seal", "@proofbook/store", "@proofbook/schema"],
  // The recipient surface must carry nothing third-party: no analytics,
  // no external fonts, no CDNs. System fonts only, assets self-hosted.
  poweredByHeader: false,
  webpack: (config) => {
    // Workspace packages use NodeNext ".js" specifiers in TS sources.
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};
