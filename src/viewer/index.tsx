
import { parseAnimgroupConfigs, parseEnvironments, parseItem, parseNpc, parseObject } from "../opdecoder";
import { ThreeJsRenderer } from "./threejsrender";
import { cacheConfigPages, cacheMajors } from "../constants";
import * as React from "react";
import * as ReactDOM from "react-dom";
import classNames from "classnames";
import { boundMethod } from "autobind-decorator";
import { HSL2RGB, ModelModifications, packedHSL2HSL } from "../3d/utils";
import { WasmGameCacheLoader as GameCacheLoader } from "../cacheloaderwasm";
import { CacheFileSource, cachingFileSourceMixin } from "../cache";

import { mapsquareModels, mapsquareToThree, ParsemapOpts, parseMapsquare, resolveMorphedObject } from "../3d/mapsquare";
import { ParsedTexture } from "../3d/textures";
import * as datastore from "idb-keyval";
import { EngineCache, ob3ModelToThreejsNode, ThreejsSceneCache } from "../3d/ob3tothree";
import { Object3D } from "three";
import { appearanceUrl, avatarStringToBytes, avatarToModel } from "../3d/avatar";
import { ModelBrowser } from "./scenenodes";
import "./fsapi";

if (module.hot) {
	module.hot.accept(["../3d/ob3togltf", "../3d/ob3tothree"]);
}

function start() {
	window.addEventListener("keydown", e => {
		if (e.key == "F5") { document.location.reload(); }
		// if (e.key == "F12") { electron.remote.getCurrentWebContents().toggleDevTools(); }
	});

	ReactDOM.render(<App />, document.getElementById("app"));

	//this service worker holds a reference to the cache fs handle which will keep the handles valid 
	//across tab reloads
	navigator.serviceWorker.register('./contextholder.js', { scope: './', });
}


//TODO rename this, it's no longer a hack
let CachedHacky = cachingFileSourceMixin(GameCacheLoader);
const hackyCacheFileSource = new CachedHacky();

let engineCache: Promise<EngineCache> | null = null;

var cacheDirectoryHandle: WebkitDirectoryHandle | null = null;
var cacheDirectoryHandlePromise: Promise<WebkitDirectoryHandle | null>;

async function ensureCachePermission() {
	if (!engineCache) {
		engineCache = (async () => {
			if (!cacheDirectoryHandle) {
				cacheDirectoryHandle = await showDirectoryPicker();
				if (!cacheDirectoryHandle) { throw new Error("permission denied"); }
			}
			await cacheDirectoryHandle.requestPermission();

			let files: Record<string, Blob> = {};
			console.log(await cacheDirectoryHandle.queryPermission());
			await cacheDirectoryHandle.requestPermission();
			for await (let handle of cacheDirectoryHandle.values()) {
				if (handle.kind == "file") {
					files[handle.name] = await handle.getFile();
				}
			}
			hackyCacheFileSource.giveBlobs(files);
			navigator.serviceWorker.ready.then(q => q.active?.postMessage({ type: "sethandle", handle: cacheDirectoryHandle }));
			datastore.set("cachefilehandles", cacheDirectoryHandle);
			let cache = await EngineCache.create(hackyCacheFileSource);
			console.log("engine loaded");
			return cache;
		})();
		engineCache.catch(() => engineCache = null);
	}
	return engineCache;
}
cacheDirectoryHandlePromise = (typeof window == undefined ? Promise.resolve(null) : datastore.get("cachefilehandles").then(oldhandle => {
	if (typeof FileSystemHandle != "undefined" && oldhandle instanceof FileSystemHandle && oldhandle.kind == "directory") {
		cacheDirectoryHandle = oldhandle;
		return oldhandle;
	}
	return null;
}));

if (typeof window != "undefined") {
	document.body.ondragover = e => e.preventDefault();
	document.body.ondrop = async e => {
		e.preventDefault();
		if (e.dataTransfer) {
			let files: Record<string, Blob> = {};
			let items: DataTransferItem[] = [];
			let folderhandles: WebkitDirectoryHandle[] = [];
			let filehandles: WebkitFileHandle[] = [];
			for (let i = 0; i < e.dataTransfer.items.length; i++) { items.push(e.dataTransfer.items[i]); }
			//needs to start synchronously as the list is cleared after the event
			await Promise.all(items.map(async item => {
				//@ts-ignore
				if (item.getAsFileSystemHandle) {
					//@ts-ignore
					let filehandle: WebkitFsHandle = await item.getAsFileSystemHandle();
					if (filehandle.kind == "file") {
						filehandles.push(filehandle);
						files[filehandle.name] = await filehandle.getFile();
					} else {
						folderhandles.push(filehandle);
						for await (let handle of filehandle.values()) {
							if (handle.kind == "file") {
								files[handle.name] = await handle.getFile();
							}
						}
					}
				} else if (item.kind == "file") {
					let file = item.getAsFile()!;
					files[file.name] = file;
				}
			}));
			if (folderhandles.length == 1 && filehandles.length == 0) {
				datastore.set("cachefilehandles", folderhandles[0]);
				console.log("stored folder " + folderhandles[0].name);
				cacheDirectoryHandle = folderhandles[0];
			}
			console.log(`added ${Object.keys(files).length} files`);
			hackyCacheFileSource.giveBlobs(files);
		}
	}
}

// const hackyCacheFileSource = new CachedHacky(path.resolve(process.env.ProgramData!, "jagex/runescape"));
// let CachedHacky = cachingFileSourceMixin(Downloader);
// const hackyCacheFileSource = new CachedHacky();

class App extends React.Component<{}, { renderer: ThreeJsRenderer | null, cache: ThreejsSceneCache | null }> {
	constructor(p) {
		super(p);
		this.state = {
			cache: null,
			renderer: null
		};
		(async () => {
			let handle = await cacheDirectoryHandlePromise;
			if (handle && await handle.queryPermission() == "granted") {
				this.requestFiles();
			}
		})();
	}

	@boundMethod
	initCnv(cnv: HTMLCanvasElement | null) {
		if (cnv) {
			let renderer = new ThreeJsRenderer(cnv, {}, hackyCacheFileSource);
			renderer.automaticFrames = true;
			console.warn("forcing auto-frames!!");
			this.setState({ renderer });
		}
	}

	@boundMethod
	requestFiles() {
		ensureCachePermission().then(engine => {
			this.setState({ cache: new ThreejsSceneCache(engine) });
		});
	}

	render() {
		return (
			<div id="content">
				<div className="canvas-container">
					<canvas id="viewer" ref={this.initCnv}></canvas>
				</div>
				<div id="sidebar">
					{!this.state.cache && <input type="button" className="sub-btn" onClick={this.requestFiles} value="Open cache" />}
					{this.state.cache && this.state.renderer && <ModelBrowser cache={this.state.cache} render={this.state.renderer} />}
				</div>
			</div >
		);
	}
}

//cache the file loads a little bit as the model loader tend to request the same texture a bunch of times
//TODO is now obsolete?
// export class MiniCache {
// 	sectors = new Map<number, Map<number, Promise<Buffer>>>();
// 	getRaw: CacheGetter;
// 	get: CacheGetter;
// 	constructor(getRaw: CacheGetter) {
// 		this.getRaw = getRaw;

// 		//use assignment instead of class method so the "this" argument is bound
// 		this.get = async (major: number, fileid: number) => {
// 			let sector = this.sectors.get(major);
// 			if (!sector) {
// 				sector = new Map();
// 				this.sectors.set(major, sector);
// 			}
// 			let file = sector.get(fileid);
// 			if (!file) {
// 				file = this.getRaw(major, fileid);
// 				sector.set(fileid, file)
// 			}
// 			return file;
// 		}
// 	}
// }

start();