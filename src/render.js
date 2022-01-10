/* eslint-disable no-new */
import fs from 'fs'
import path from 'path'
// sharp must be before zlib and other imports or sharp gets wrong version of zlib and breaks on some servers
import sharp from 'sharp'
import zlib from 'zlib'
import geoViewport from '@mapbox/geo-viewport'
import mbgl from '@mapbox/mapbox-gl-native'
import MBTiles from '@mapbox/mbtiles'
import webRequest from 'request'

import { URL } from 'url'

const TILE_REGEXP = RegExp('mbtiles://([^/]+)/(\\d+)/(\\d+)/(\\d+)')
const MBTILES_REGEXP = /mbtiles:\/\/(\S+?)(?=[/"]+)/gi

export const isMapboxURL = url => url.startsWith('mapbox://')
export const isMapboxStyleURL = url => url.startsWith('mapbox://styles/')
const isMBTilesURL = url => url.startsWith('mbtiles://')

export const isGeoloniaURL = url => url.startsWith('geolonia://') || url.includes('tileserver.geolonia.com')

// normalize functions derived from: https://github.com/geolonia/embed/blob/master/src/lib/geolonia-map.js
const normalizeGeoloniaURL = (urlString, token) => {
    let url = new URL(urlString)
    if (url.protocol === 'geolonia:' && url.host === 'tiles') {
        const [ username, tileset ] = url.pathname.split('/')
        if (username === 'base') {
            url = new URL(`https://tileserver.geolonia.com/${tileset}/tiles.json`);
        } else {
            url = new URL(`https://tileserver.geolonia.com/customtiles/${tileset}/tiles.json`);
        }
        url.searchParams.set('key', token);
    } else if (url.protocol == 'geolonia:' && url.host === 'styles') {
        url = new URL(`https://cdn.geolonia.com/styles${url.pathname}/ja.json`)
    } else if (url.host === 'tileserver.geolonia.com') {
        url.searchParams.set('key', token);
    }
    return url.toString();
}

// normalize functions derived from: https://github.com/mapbox/mapbox-gl-js/blob/master/src/util/mapbox.js

/**
 * Normalize a Mapbox source URL to a full URL
 * @param {string} urlStr - url to mapbox source in style json, e.g. "url": "mapbox://mapbox.mapbox-streets-v7"
 * @param {string} token - mapbox public token
 */
const normalizeMapboxSourceURL = (urlStr, token) => {
    const urlObject = new URL(urlStr)
    urlObject.query = urlObject.query || {}
    urlObject.pathname = `/v4/${urlStr.split('mapbox://')[1]}.json`
    urlObject.protocol = 'https'
    urlObject.host = 'api.mapbox.com'
    urlObject.query.secure = true
    urlObject.query.access_token = token
    return urlObject.toString()
}

/**
 * Normalize a Mapbox tile URL to a full URL
 * @param {string} urlStr - url to mapbox tile in style json or resolved from source
 * e.g. mapbox://tiles/mapbox.mapbox-streets-v7/1/0/1.vector.pbf
 * @param {string} token - mapbox public token
 */
const normalizeMapboxTileURL = (urlStr, token) => {
    const urlObject = new URL(urlStr)
    urlObject.query = urlObject.query || {}
    urlObject.pathname = `/v4${urlObject.path}`
    urlObject.protocol = 'https'
    urlObject.host = 'a.tiles.mapbox.com'
    urlObject.query.access_token = token
    return urlObject.toString();
}

/**
 * Normalize a Mapbox style URL to a full URL
 * @param {string} url - url to mapbox source in style json, e.g. "url": "mapbox://styles/mapbox/streets-v9"
 * @param {string} token - mapbox public token
 */
export const normalizeMapboxStyleURL = (urlStr, token) => {
    const urlObject = new URL(urlStr)
    urlObject.query = {
        access_token: token,
        secure: true,
    }
    urlObject.pathname = `styles/v1${urlObject.path}`
    urlObject.protocol = 'https'
    urlObject.host = 'api.mapbox.com'
    return urlObject.toString()
}

/**
 * Normalize a Mapbox sprite URL to a full URL
 * @param {string} urlStr - url to mapbox sprite, e.g. "url": "mapbox://sprites/mapbox/streets-v9.png"
 * @param {string} token - mapbox public token
 *
 * Returns {string} - url, e.g., "https://api.mapbox.com/styles/v1/mapbox/streets-v9/sprite.png?access_token=<token>"
 */
export const normalizeMapboxSpriteURL = (urlStr, token) => {
    const extMatch = /(\.png|\.json)$/g.exec(urlStr)
    const ratioMatch = /(@\d+x)\./g.exec(urlStr)
    const trimIndex = Math.min(
        ratioMatch != null ? ratioMatch.index : Infinity,
        extMatch.index
    )
    const urlObject = new URL(urlStr.substring(0, trimIndex))

    const extPart = extMatch[1]
    const ratioPart = ratioMatch != null ? ratioMatch[1] : ''
    urlObject.query = urlObject.query || {}
    urlObject.query.access_token = token
    urlObject.pathname = `/styles/v1${urlObject.path}/sprite${ratioPart}${extPart}`
    urlObject.protocol = 'https'
    urlObject.host = 'api.mapbox.com'
    return urlObject.toString()
}

/**
 * Normalize a Mapbox glyph URL to a full URL
 * @param {string} urlStr - url to mapbox sprite, e.g. "url": "mapbox://sprites/mapbox/streets-v9.png"
 * @param {string} token - mapbox public token
 *
 * Returns {string} - url, e.g., "https://api.mapbox.com/styles/v1/mapbox/streets-v9/sprite.png?access_token=<token>"
 */
export const normalizeMapboxGlyphURL = (urlStr, token) => {
    const urlObject = new URL(urlStr)
    urlObject.query = urlObject.query || {}
    urlObject.query.access_token = token
    urlObject.pathname = `/fonts/v1${urlObject.path}`
    urlObject.protocol = 'https'
    urlObject.host = 'api.mapbox.com'
    return urlObject.toString()
}

/**
 * Very simplistic function that splits out mbtiles service name from the URL
 *
 * @param {String} url - URL to resolve
 */
const resolveNamefromURL = url => url.split('://')[1].split('/')[0]

/**
 * Resolve a URL of a local mbtiles file to a file path
 * Expected to follow this format "mbtiles://<service_name>/*"
 *
 * @param {String} tilePath - path containing mbtiles files
 * @param {String} url - url of a data source in style.json file.
 */
const resolveMBTilesURL = (tilePath, url) =>
    path.format({
        dir: tilePath,
        name: resolveNamefromURL(url),
        ext: '.mbtiles',
    })

/**
 * Given a URL to a local mbtiles file, get the TileJSON for that to load correct tiles.
 *
 * @param {String} tilePath - path containing mbtiles files.
 * @param {String} url - url of a data source in style.json file.
 * @param {function} callback - function to call with (err, {data}).
 */
const getLocalTileJSON = (tilePath, url, callback) => {
    const mbtilesFilename = resolveMBTilesURL(tilePath, url)
    const service = resolveNamefromURL(url)

    new MBTiles(mbtilesFilename, (err, mbtiles) => {
        if (err) {
            callback(err)
            return null
        }

        mbtiles.getInfo((infoErr, info) => {
            if (infoErr) {
                callback(infoErr)
                return null
            }

            const { minzoom, maxzoom, center, bounds, format } = info

            const ext = format === 'pbf' ? '.pbf' : ''

            const tileJSON = {
                tilejson: '1.0.0',
                tiles: [`mbtiles://${service}/{z}/{x}/{y}${ext}`],
                minzoom,
                maxzoom,
                center,
                bounds,
            }

            callback(null, { data: Buffer.from(JSON.stringify(tileJSON)) })
            return null
        })

        return null
    })
}

/**
 * Fetch a tile from a local mbtiles file.
 *
 * @param {String} tilePath - path containing mbtiles files.
 * @param {String} url - url of a data source in style.json file.
 * @param {function} callback - function to call with (err, {data}).
 */
const getLocalTile = (tilePath, url, callback) => {
    const matches = url.match(TILE_REGEXP)
    const [z, x, y] = matches.slice(matches.length - 3, matches.length)
    const isVector = path.extname(url) === '.pbf'
    const mbtilesFile = resolveMBTilesURL(tilePath, url)

    new MBTiles(mbtilesFile, (err, mbtiles) => {
        if (err) {
            callback(err)
            return null
        }

        mbtiles.getTile(z, x, y, (tileErr, data) => {
            if (tileErr) {
                // console.error(`error fetching tile: z:${z} x:${x} y:${y} from ${mbtilesFile}\n${tileErr}`)
                callback(null, {})
                return null
            }

            if (isVector) {
                // if the tile is compressed, unzip it (for vector tiles only!)
                zlib.unzip(data, (unzipErr, unzippedData) => {
                    callback(unzipErr, { data: unzippedData })
                })
            } else {
                callback(null, { data })
            }

            return null
        })

        return null
    })
}

/**
 * Fetch a remotely hosted tile.
 * Empty or missing tiles return null data to the callback function, which
 * result in those tiles not rendering but no errors being raised.
 *
 * @param {String} url - URL of the tile
 * @param {function} callback - callback to call with (err, {data})
 */
const getRemoteTile = (url, callback) => {
    webRequest(
        {
            url,
            encoding: null,
            gzip: true,
            headers: {
                'Origin': 'http://localhost:3000',
            },
        },
        (err, res, data) => {
            if (err) {
                return callback(err)
            }

            switch (res.statusCode) {
                case 200: {
                    return callback(null, { data })
                }
                case 204: {
                    // No data for this url
                    return callback(null, {})
                }
                case 404: {
                    // Tile not found
                    // this may be valid for some tilesets that have partial coverage
                    // on servers that do not return blank tiles in these areas.
                    console.warn(`Missing tile at: ${url}`)
                    return callback(null, {})
                }
                default: {
                    // assume error
                    console.error(
                        `Error with request for: ${url}\nstatus: ${res.statusCode}`
                    )
                    return callback(
                        new Error(
                            `Error with request for: ${url}\nstatus: ${res.statusCode}`
                        )
                    )
                }
            }
        }
    )
}

/**
 * Fetch a remotely hosted asset: glyph, sprite, etc
 * Anything other than a HTTP 200 response results in an exception.
 *
 *
 * @param {String} url - URL of the asset
 * @param {function} callback - callback to call with (err, {data})
 */
const getRemoteAsset = (url, callback) => {
    webRequest(
        {
            url,
            encoding: null,
            gzip: true,
            headers: {
                'Origin': 'http://localhost:3000',
            },
        },
        (err, res, data) => {
            if (err) {
                return callback(err)
            }

            switch (res.statusCode) {
                case 200: {
                    return callback(null, { data })
                }
                default: {
                    // assume error
                    console.error(
                        `Error with request for: ${url}\nstatus: ${res.statusCode}`
                    )
                    return callback(
                        new Error(
                            `Error with request for: ${url}\nstatus: ${res.statusCode}`
                        )
                    )
                }
            }
        }
    )
}

/**
 * Render a map using Mapbox GL, based on layers specified in style.
 * Returns a Promise with the PNG image data as its first parameter for the map image.
 * If zoom and center are not provided, bounds must be provided
 * and will be used to calculate center and zoom based on image dimensions.
 *
 * @param {Object} style - Mapbox GL style object
 * @param {number} width - width of output map (default: 1024)
 * @param {number} height - height of output map (default: 1024)
 * @param {Object} - configuration object containing style, zoom, center: [lng, lat],
 * width, height, bounds: [west, south, east, north], ratio, padding
 * @param {String} tilePath - path to directory containing local mbtiles files that are
 * referenced from the style.json as "mbtiles://<tileset>"
 */
export const render = (style, width = 1024, height = 1024, options) =>
    new Promise((resolve, reject) => {
        const {
            bounds = null,
            bearing = 0,
            pitch = 0,
            mapboxToken = null,
            geoloniaToken = null,
            ratio = 1,
            padding = 0,
        } = options
        let { center = null, zoom = null, tilePath = null } = options

        if (!style) {
            throw new Error('style is a required parameter')
        }
        if (!(width && height)) {
            throw new Error(
                'width and height are required parameters and must be non-zero'
            )
        }

        if (center !== null) {
            if (center.length !== 2) {
                throw new Error(
                    `Center must be longitude,latitude.  Invalid value found: ${[
                        ...center,
                    ]}`
                )
            }

            if (Math.abs(center[0]) > 180) {
                throw new Error(
                    `Center longitude is outside world bounds (-180 to 180 deg): ${center[0]}`
                )
            }

            if (Math.abs(center[1]) > 90) {
                throw new Error(
                    `Center latitude is outside world bounds (-90 to 90 deg): ${center[1]}`
                )
            }
        }

        if (zoom !== null && (zoom < 0 || zoom > 22)) {
            throw new Error(
                `Zoom level is outside supported range (0-22): ${zoom}`
            )
        }

        if (bearing !== null && (bearing < 0 || bearing > 360)) {
            throw new Error(
                `bearing is outside supported range (0-360): ${bearing}`
            )
        }

        if (pitch !== null && (pitch < 0 || pitch > 60)) {
            throw new Error(`pitch is outside supported range (0-60): ${pitch}`)
        }

        if (bounds !== null) {
            if (bounds.length !== 4) {
                throw new Error(
                    `Bounds must be west,south,east,north.  Invalid value found: ${[
                        ...bounds,
                    ]}`
                )
            }

            if (padding) {
                // padding must not be greater than width / 2 and height / 2
                if (Math.abs(padding) >= width / 2) {
                    throw new Error('Padding must be less than width / 2')
                }
                if (Math.abs(padding) >= height / 2) {
                    throw new Error('Padding must be less than height / 2')
                }
            }
        }

        // calculate zoom and center from bounds and image dimensions
        if (bounds !== null && (zoom === null || center === null)) {
            const viewport = geoViewport.viewport(
                bounds,
                // add padding to width and height to effectively
                // zoom out the target zoom level.
                [width - 2 * padding, height - 2 * padding],
                undefined,
                undefined,
                undefined,
                true
            )
            zoom = Math.max(viewport.zoom - 1, 0)
            /* eslint-disable prefer-destructuring */
            center = viewport.center
        }

        // validate that all local mbtiles referenced in style are
        // present in tilePath and that tilePath is not null
        if (tilePath) {
            tilePath = path.normalize(tilePath)
        }

        const localMbtilesMatches = JSON.stringify(style).match(MBTILES_REGEXP)
        if (localMbtilesMatches && !tilePath) {
            throw new Error(
                'Style has local mbtiles file sources, but no tilePath is set'
            )
        }

        if (localMbtilesMatches) {
            localMbtilesMatches.forEach(name => {
                const mbtileFilename = path.normalize(
                    path.format({
                        dir: tilePath,
                        name: name.split('://')[1],
                        ext: '.mbtiles',
                    })
                )
                if (!fs.existsSync(mbtileFilename)) {
                    throw new Error(
                        `Mbtiles file ${path.format({
                            name,
                            ext: '.mbtiles',
                        })} in style file is not found in: ${path.resolve(
                            tilePath
                        )}`
                    )
                }
            })
        }

        // Options object for configuring loading of map data sources.
        // Note: could not find a way to make this work with mapbox vector sources and styles!
        const mapOptions = {
            request: (req, callback) => {
                const { url, kind } = req

                const isMapbox = isMapboxURL(url)
                if (isMapbox && !mapboxToken) {
                    throw new Error('ERROR: mapbox access token is required')
                }
                const isGeolonia = isGeoloniaURL(url)
                if (isGeolonia && !geoloniaToken) {
                    throw new Error('ERROR: Geolonia access token is required')
                }

                try {
                    switch (kind) {
                        case 2: {
                            // source
                            if (isMBTilesURL(url)) {
                                getLocalTileJSON(tilePath, url, callback)
                            } else if (isMapbox) {
                                getRemoteAsset(
                                    normalizeMapboxSourceURL(url, mapboxToken),
                                    callback
                                )
                            } else if (isGeolonia) {
                                getRemoteAsset(
                                    normalizeGeoloniaURL(url, geoloniaToken),
                                    callback
                                )
                            } else {
                                getRemoteAsset(url, callback)
                            }
                            break
                        }
                        case 3: {
                            // tile
                            if (isMBTilesURL(url)) {
                                getLocalTile(tilePath, url, callback)
                            } else if (isMapbox) {
                                // This seems to be due to a bug in how the mapbox tile
                                // JSON is handled within mapbox-gl-native
                                // since it returns fully resolved tiles!
                                getRemoteTile(
                                    normalizeMapboxTileURL(url, mapboxToken),
                                    callback
                                )
                            } else if (isGeolonia) {
                                getRemoteTile(
                                    normalizeGeoloniaURL(url, geoloniaToken),
                                    callback
                                )
                            } else {
                                getRemoteTile(url, callback)
                            }
                            break
                        }
                        case 4: {
                            // glyph
                            getRemoteAsset(
                                isMapbox
                                    ? normalizeMapboxGlyphURL(url, mapboxToken)
                                    : new URL(url),
                                callback
                            )
                            break
                        }
                        case 5: {
                            // sprite image
                            getRemoteAsset(
                                isMapbox
                                    ? normalizeMapboxSpriteURL(url, mapboxToken)
                                    : new URL(url),
                                callback
                            )
                            break
                        }
                        case 6: {
                            // sprite json
                            getRemoteAsset(
                                isMapbox
                                    ? normalizeMapboxSpriteURL(url, mapboxToken)
                                    : new URL(url),
                                callback
                            )
                            break
                        }
                        case 7: {
                            // image source
                            getRemoteAsset(new URL(url), callback)
                            break
                        }
                        default: {
                            // NOT HANDLED!
                            throw new Error(
                                `ERROR: Request kind not handled: ${kind}`
                            )
                        }
                    }
                } catch (err) {
                    console.error('Error while making tile request: %j', err)
                    callback(err)
                }
            },
            ratio,
        }

        const map = new mbgl.Map(mapOptions)
        map.load(style)

        map.render(
            {
                zoom,
                center,
                height,
                width,
                bearing,
                pitch,
            },
            (err, buffer) => {
                if (err) {
                    console.error('Error rendering map')
                    console.error(err)
                    return reject(err)
                }

                map.release() // release map resources to prevent reusing in future render requests

                // Un-premultiply pixel values
                // Mapbox GL buffer contains premultiplied values, which are not handled correctly by sharp
                // https://github.com/mapbox/mapbox-gl-native/issues/9124
                // since we are dealing with 8-bit RGBA values, normalize alpha onto 0-255 scale and divide
                // it out of RGB values
                for (let i = 0; i < buffer.length; i += 4) {
                    const alpha = buffer[i + 3]
                    const norm = alpha / 255
                    if (alpha === 0) {
                        buffer[i] = 0
                        buffer[i + 1] = 0
                        buffer[i + 2] = 0
                    } else {
                        buffer[i] = buffer[i] / norm
                        buffer[i + 1] = buffer[i + 1] / norm
                        buffer[i + 2] = buffer[i + 2] / norm
                    }
                }

                // Convert raw image buffer to PNG
                try {
                    return sharp(buffer, {
                        raw: {
                            width: width * ratio,
                            height: height * ratio,
                            channels: 4,
                        },
                    })
                        .png()
                        .toBuffer()
                        .then(resolve)
                        .catch(reject)
                } catch (pngErr) {
                    console.error('Error encoding PNG')
                    console.error(pngErr)
                    return reject(pngErr)
                }
            }
        )
    })

export default render
