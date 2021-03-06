//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const adalNode = require('adal-node');
const async = require('async');
const azureKeyVault = require('azure-keyvault');
const objectPath = require('object-path');
const url = require('url');

// Key Vault Configuration Assumptions:
// In URL syntax, we define a custom scheme of "keyvault://" which resolves
// a KeyVault secret ID, replacing the original. To use a tag (a custom
// attribute on a secret - could be a username for example), use the tag
// name as the auth parameter of the URL.
//
// For example:
//   keyvault://myCustomTag@keyvaultname.vault.azure.net/secrets/secret-value-name/secretVersion",
//
// Would resolve the "myCustomTag" value instead of the secret value.
//
// You can also chose to leave the version off, so that the most recent version
// of the secret will be resolved during the resolution process.
//
// In the case that a KeyVault secret ID is needed inside the app, and not
// handled at startup, then the secret ID (a URI) can be included without
// the custom keyvault:// scheme.
//
// Note that this use of a custom scheme called "keyvault" is not an officially
// recommended or supported approach for KeyVault use in applications, and may
// not be endorsed by the engineering team responsible for KeyVault, but for our
// group and our Node apps, it has been very helpful.

const keyVaultProtocol = 'keyvault:';
const httpsProtocol = 'https:';

function getSecret(keyVaultClient, secretStash, secretId, callback) {
  const cached = secretStash.get(secretId);
  if (cached) {
    return callback(null, cached);
  }
  keyVaultClient.getSecret(secretId, (getSecretError, secretResponse) => {
    if (getSecretError) {
      return callback(getSecretError);
    }
    secretStash.set(secretId, secretResponse);
    return callback(null, secretResponse);
  });
}

function getUrlIfVault(value) {
  try {
    const keyVaultUrl = url.parse(value);
    if (keyVaultUrl.protocol === keyVaultProtocol) {
      return keyVaultUrl;
    }
  }
  catch (typeError) {
    /* ignore */
  }
  return undefined;
}

function identifyKeyVaultValuePaths(node, prefix) {
  prefix = prefix !== undefined ? prefix + '.' : '';
  const paths = {};
  for (const property in node) {
    const value = node[property];
    if (typeof value === 'object') {
      Object.assign(paths, identifyKeyVaultValuePaths(value, prefix + property));
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const keyVaultUrl = getUrlIfVault(value);
    if (keyVaultUrl === undefined) {
      continue;
    }
    paths[prefix + property] = keyVaultUrl;
  }
  return paths;
}

function wrapClient(keyVaultClient) {
  keyVaultClient.getObjectSecrets = function resolveSecrets(object, callback) {
    let paths = null;
    try {
      paths = identifyKeyVaultValuePaths(object);
    } catch(parseError) {
      return callback(parseError);
    }

    // Build a unique list of secrets, fetch them at once
    const uniqueUris = new Set();
    const properties = new Map();
    for (const path in paths) {
      const value = paths[path];
      const tag = value.auth;
      value.protocol = httpsProtocol;
      value.auth = null;
      const uri = url.format(value);
      properties.set(path, [uri, tag]);
      uniqueUris.add(uri);
    }
    const secretStash = new Map();
    const uniques = Array.from(uniqueUris.values());
    async.each(uniques, getSecret.bind(null, keyVaultClient, secretStash), error => {
      if (error) {
        return callback(error);
      }
      for (const path in paths) {
        const [uri, tag] = properties.get(path);
        const secretResponse = secretStash.get(uri);

        let value = undefined;
        if (tag === null) {
          value = secretResponse.value;
        } else if (secretResponse.tags) {
          value = secretResponse.tags[tag];
        }

        objectPath.set(object, path, value);
      }

      return callback();
    });
  };
  return keyVaultClient;
}

function createAndWrapKeyVaultClient(options) {
  if (!options) {
    throw new Error('No options provided for the key vault resolver.');
  }
  let client = options && options.getSecret && typeof(options.getSecret) === 'function' ? options : options.client;
  if (options.credentials && !client) {
    client = new azureKeyVault.KeyVaultClient(options.credentials);
  }
  if (!client) {
    let clientId = null;
    let clientSecret = null;
    let getClientCredentials = options.getClientCredentials;
    if (!getClientCredentials) {
      if (!options.clientId) {
        throw new Error('Must provide an Azure Active Directory "clientId" value to the key vault resolver.');
      }
      if (!options.clientSecret) {
        throw new Error('Must provide an Azure Active Directory "clientSecret" value to the key vault resolver.');
      }
      clientId = options.clientId;
      clientSecret = options.clientSecret;
    }

    const authenticator = (challenge, authCallback) => {
      const context = new adalNode.AuthenticationContext(challenge.authorization);

      // Support optional delayed secret resolution
      if (getClientCredentials && (!clientId || !clientSecret)) {
        try {
          const ret = getClientCredentials();
          if (ret) {
            clientId = ret.clientId;
            clientSecret = ret.clientSecret;
          }
        } catch (getClientCredentialsError) {
          return authCallback(getClientCredentialsError);
        }
        if (!clientId || !clientSecret) {
          return authCallback(new Error('After calling getClientCredentials, "clientId" and/or "clientSecret" remained unset. These values are required to authenticate with the vault.'));
        }
      }

      return context.acquireTokenWithClientCredentials(challenge.resource, clientId, clientSecret, (tokenAcquisitionError, tokenResponse) => {
        if (tokenAcquisitionError) {
          return authCallback(tokenAcquisitionError);
        }
        const authorizationValue = `${tokenResponse.tokenType} ${tokenResponse.accessToken}`;
        return authCallback(null, authorizationValue);
      });
    };
    const credentials = new azureKeyVault.KeyVaultCredentials(authenticator);
    client = new azureKeyVault.KeyVaultClient(credentials);
  }
  return wrapClient(client);
}

module.exports = createAndWrapKeyVaultClient;
