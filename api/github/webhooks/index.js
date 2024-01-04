import {App, createNodeMiddleware} from 'octokit'
import {StatusCodes} from 'http-status-codes'
import * as YAML from 'yaml'
import * as http from "http";

const PROPERTIES_FILE_PATH = '.github/properties.yaml'
const APP = new App({
    appId: process.env.APP_ID,
    privateKey: formatPEMKey(process.env.PRIVATE_KEY),
    webhooks: {
        secret: process.env.WEBHOOK_SECRET,
    },
    oauth: {clientId: '', clientSecret: ''}, // WORKAROUND due to https://github.com/octokit/octokit.js/issues/2211
})


APP.webhooks.on('push', async ({octokit, payload}) => {
    console.info('event: push,', `repository: ${payload.repository.full_name}`)

    if (payload.repository.owner.type !== 'Organization') {
        throw Error('Only Organization repositories are supported')
    }

    if (!payload.commits.some(commit => commitIncludesFile(commit, PROPERTIES_FILE_PATH))) {
        console.info(`skip - push does not includes ${PROPERTIES_FILE_PATH}`)
        return
    }

    const orgCustomPropertiesSchema = await octokit.rest.orgs
        .getAllCustomProperties({org: payload.repository.owner.name})
        .then((res) => res.data)
    console.debug('organization custom properties schema: ' + JSON.stringify(orgCustomPropertiesSchema, null, 2))
    const orgCustomPropertiesSchemaMap = Object.fromEntries(orgCustomPropertiesSchema.map(it => [it.property_name, it]))

    const repoCustomProperties = await octokit.rest.orgs.listCustomPropertiesValuesForRepos({
            org: payload.repository.owner.name,
            repository_names: [payload.repository.name],
        })
        .then((res) => res.data[0].properties)
    console.debug('repository custom properties: ' + JSON.stringify(repoCustomProperties, null, 2))

    const customPropertiesMapFromFile = await octokit.rest.repos.getContent({
            owner: payload.repository.owner.name,
            repo: payload.repository.name,
            path: PROPERTIES_FILE_PATH,
        })
        .catch(NotFoundToNull)
        .then((res) => Buffer.from(res.data.content, res.data.encoding).toString())
        .then((content) => YAML.parse(content) || {})
    console.debug(`repository custom properties from ${PROPERTIES_FILE_PATH}: ` + JSON.stringify(customPropertiesMapFromFile, null, 2))

    const modifiedRepoCustomProperties = repoCustomProperties
        .map(currentRepoProperty => {
            let newRepoProperty = {
                ...currentRepoProperty,
                old_value: currentRepoProperty.value,
                value: customPropertiesMapFromFile[currentRepoProperty.property_name] ?? null,
            }

            if (currentRepoProperty.value === newRepoProperty.value) {
                return
            }

            // if a property has default value configured in schema
            // and the repository property value is already set to default value
            // then updating this property to null can be skipped
            if (newRepoProperty.value === null
                && currentRepoProperty.value === orgCustomPropertiesSchemaMap[currentRepoProperty.property_name].default_value
            ) {
                return
            }

            return newRepoProperty
        })
        .filter(Boolean)

    console.info('modified repository custom properties: '
        + JSON.stringify(modifiedRepoCustomProperties, null, 2))

    await octokit.rest.orgs.createOrUpdateCustomPropertiesValuesForRepos({
        org: payload.repository.owner.name,
        repository_names: [payload.repository.name],
        properties: modifiedRepoCustomProperties.map(it => ({
            property_name: it.property_name,
            value: it.value,
        })),
    })
})

APP.webhooks.onError((error) => {
    if (error.name === 'AggregateError') {
        console.error(`Error processing request: ${error.event}`)
    } else {
        console.error(error);
    }
})

export default http.createServer(createNodeMiddleware(APP))

// --- Util Functions --------------------------------------------------------------------------------------------------

function commitIncludesFile(commit, filePath) {
    return [commit.added, commit.modified, commit.removed].some(files => files.includes(filePath))
}

function NotFoundToNull(error) {
    if (error.status === StatusCodes.NOT_FOUND) return null
    throw error
}

function formatPEMKey(keyString) {
    const headerMatch = keyString.match(/^\s*-----BEGIN [\w\d\s]+ KEY-----/g)
    const footerMatch = keyString.match(/-----END [\w\d\s]+ KEY-----\s*$/g)
    if (!headerMatch || !footerMatch) throw Error('Invalid key format')

    const key = keyString
        .slice(headerMatch[0].length)
        .slice(0, -footerMatch[0].length)
        .replace(/\s+/g, '')

    return headerMatch[0] + '\n' +
        key.replace(/.{1,64}/g, '$&\n') +
        footerMatch[0] + '\n'
}
