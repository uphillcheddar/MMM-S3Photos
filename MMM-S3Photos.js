const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'm4v']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);

Module.register("MMM-S3Photos", {
    defaults: {
        syncTimeHours: 1, // How often to run the Lambda function and run the delta logic
        cacheLifeDays: 0, // 0 = never clean cache, >0 = days between cache purges
        displayDurationSeconds: 30, // How long (seconds) to display each photo
        transitionDurationSeconds: 2, // How long (seconds) the transition animation takes
        displayStyle: "wallpaper", // Choose one:
                                  // "wallpaper" (fills entire screen)
                                  // "fill" (fills container region)
                                  // "fit-display" (maintains aspect ratio, fills display)
                                  // "absolute" (fixed size)
        absoluteOptions: {
            enabled: false,
            side: "horizontal", // "horizontal" or "vertical"
            size: 400,  // Image will be max 400px wide
            blurContainer: {
                width: 500, // pixels only used if applyBlur and absolute options are enabled.
                height: 500  // pixels
            }
        },
        applyBlur: false, // Apply blur effect to empty space
        displayOrder: "random", // "newest_first", "oldest_first", "random", "random_dedupe"
        video: {
            enabled: true,           // Enable/disable video playback
            autoplay: true,          // Auto-start videos
            muted: true,             // Mute videos (required for autoplay)
            loop: false,             // Loop individual videos
            controls: false,         // Show video controls
            preload: 'metadata',     // Preload strategy ('none', 'metadata', 'auto')
            videosOnly: false        // Show only videos (filter out images)
        },
        attribution: {
            enabled: true,
            attributions: {
                "samples": "Sample Photography"
            },
            position: "static", // "static" or "dynamic"
            corner: "bottom-right", // "top-left", "top-right", "bottom-left", "bottom-right" ignored if position is dynamic
            relativeTo: "display" // "display" or "image"
        },
        selfieUploads: false,  // Whether to process and upload photos from MMM-Selfieshot
        selfieFolder: "selfies" // S3 folder name for selfie uploads
    },

    start: function() {
        Log.debug("Starting module: " + this.name);
        this.photos = [];
        this.cacheDir = 'cache';
        this.loaded = false;
        this.moduleLoaded = false;
        this.sortedPhotos = null;
        this.currentIndex = 0;
        this.imagesDisplayed = 0;
        this.dedupeQueue = this._loadDedupeQueue();
        this.shownKeys = this._loadShownKeys();

        // Set transition duration from config
        const wrapper = document.getElementById(this.identifier);
        if (wrapper) {
            wrapper.style.setProperty('--transition-duration', `${this.config.transitionDurationSeconds || 2}s`);
        }
    },

    getMediaType: function(key) {
        const ext = key.toLowerCase().split('.').pop();
        if (VIDEO_EXTS.has(ext)) return 'video';
        if (IMAGE_EXTS.has(ext)) return 'image';
        return 'unknown';
    },

    createMediaElements: function() {
        // Create photo elements
        const photoBack = document.createElement("div");
        photoBack.className = "photo-back";
        
        const photoCurrent = document.createElement("div");
        photoCurrent.className = "photo-current";
        
        // Create video element
        const videoCurrent = document.createElement("video");
        videoCurrent.className = "video-current";
        videoCurrent.style.display = "none";
        videoCurrent.preload = this.config.video.preload;
        videoCurrent.muted = this.config.video.muted;
        // muted IDL property doesn't reflect to the DOM attribute, so cloneNode(true)
        // would produce an unmuted clone and Chromium's autoplay policy blocks play().
        if (this.config.video.muted) videoCurrent.setAttribute("muted", "");
        videoCurrent.controls = this.config.video.controls;
        
        return { photoBack, photoCurrent, videoCurrent };
    },

    notificationReceived: function(notification, payload, sender) {
        if (notification === "ALL_MODULES_STARTED") {
            Log.debug(this.name + " received ALL_MODULES_STARTED notification");
            this.moduleLoaded = true;
            this.initialize();
        } else if (notification === "GPHOTO_UPLOAD" && this.config.selfieUploads) {
            Log.debug("Received new photo notification:");
            this.sendSocketNotification("NEW_PHOTO", {
                path: payload,
                folder: this.config.selfieFolder
            });
        } else if (notification === "DOM_OBJECTS_CREATED") {
            // Handle initial load
        }
    },

    initialize: function() {
        Log.debug(this.name + " initializing...");
        
        // Ensure we have valid configuration
        if (!this.config.syncTimeHours || this.config.syncTimeHours < 1) {
            this.config.syncTimeHours = 1;
        }
        
        this.getPhotos();
        
        // Set up photo rotation timer
        this.scheduleNextPhoto();
        
        // Set up intervals for photo refresh
        setInterval(() => {
            this.getPhotos();
        }, this.config.syncTimeHours * 3600000);

        // Only set up cache cleanup if enabled
        if (this.config.cacheLifeDays > 0) {
            Log.debug(this.name + " setting up cache cleanup interval");
            setInterval(() => {
                this.cleanupCache().catch(err => {
                    Log.error("Error during cache cleanup:", err);
                });
            }, this.config.cacheLifeDays * 86400000);
        } else {
            Log.debug(this.name + " cache cleanup disabled");
        }
    },

    getPhotos: function() {
        if (!this.moduleLoaded) {
            Log.warn(this.name + " tried to get photos before module was loaded");
            return;
        }
        
        Log.debug("Requesting photos from node helper");
        this.sendSocketNotification("GET_PHOTOS", { 
            cacheDir: this.cacheDir,
            moduleName: this.name
        });
    },

    socketNotificationReceived: function(notification, payload) {
        if (!this.moduleLoaded) {
            Log.warn(this.name + " received socket notification before module was loaded");
            return;
        }

        Log.debug(this.name + " received socket notification:", notification);
        
        // Only handle PHOTOS_UPDATED and PHOTOS_ERROR notifications here
        // These are display-specific notifications that won't create loops
        switch(notification) {
            case "PHOTOS_UPDATED":
                if (Array.isArray(payload) && payload.length > 0) {
                    Log.debug("Received photos array with length:", payload.length);
                    
                    // Filter to videos only if configured
                    if (this.config.video.videosOnly) {
                        this.photos = payload.filter(item => {
                            const mediaType = this.getMediaType(item.key);
                            return mediaType === 'video';
                        });
                        Log.debug(`Filtered to ${this.photos.length} videos only`);
                    } else {
                        this.photos = payload;
                    }

                    // Sort photos based on configuration
                    if (this.config.displayOrder === "newest_first") {
                        const withTime = this.photos.map(p => ({ p, t: new Date(p.lastModified).getTime() }));
                        withTime.sort((a, b) => b.t - a.t);
                        this.photos = withTime.map(x => x.p);
                    } else if (this.config.displayOrder === "oldest_first") {
                        const withTime = this.photos.map(p => ({ p, t: new Date(p.lastModified).getTime() }));
                        withTime.sort((a, b) => a.t - b.t);
                        this.photos = withTime.map(x => x.p);
                    } else if (this.config.displayOrder === "random_dedupe") {
                        this._reconcileDedupeQueue();
                    }
                    
                    this.errorMessage = null;
                    this.loaded = true;
                    this.updateDom(0);
                    this.scheduleNextPhoto();
                } else {
                    Log.warn("Received empty or invalid photos array");
                    this.photos = [];
                    this.errorMessage = "No photos available";
                    this.loaded = true;
                    this.updateDom(0);
                }
                break;

            case "PHOTOS_ERROR":
                Log.error("Error received from node helper:", payload);
                this.loaded = true;
                this.errorMessage = typeof payload === 'object' ? 
                    (payload.message || JSON.stringify(payload)) : 
                    (payload || 'Failed to load photos. Check the server logs for details.');
                this.updateDom(0);
                break;
        }
    },

    cleanupCache: async function() {
        try {
            const cacheFile = path.join(this.cacheDir, 'photos.json');
            if (fs.existsSync(cacheFile)) {
                fs.unlinkSync(cacheFile);
            }
            const files = await fs.promises.readdir(this.cacheDir);
            await Promise.all(files.map(file => fs.promises.unlink(path.join(this.cacheDir, file))));
            
            // Trigger sync after cleanup
            Log.debug("Cache cleanup complete, triggering photo sync");
            this.getPhotos();
        } catch (err) {
            console.error("Error during cache cleanup: " + err);
        }
    },


    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = `MMM-S3Photos ${this.config.displayStyle}`;

        // Show a spinner while photos are still being downloaded from S3
        if (!this.loaded) {
            const loading = document.createElement("div");
            loading.className = "s3photos-loading";

            const spinner = document.createElement("div");
            spinner.className = "s3photos-spinner";

            const msg = document.createElement("p");
            msg.className = "s3photos-loading-msg";
            msg.textContent = "Downloading data from S3, this may take some time depending on photo/video volume.";

            loading.appendChild(spinner);
            loading.appendChild(msg);
            wrapper.appendChild(loading);
            return wrapper;
        }

        // Handle absolute sizing
        if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
            const size = this.config.absoluteOptions.size || 400;
            wrapper.classList.add(this.config.absoluteOptions.side); // Add horizontal/vertical class
            
            // Set CSS custom properties for dimensions
            if (this.config.absoluteOptions.side === "horizontal") {
                wrapper.style.setProperty('--absolute-width', `${size}px`);
            } else {
                wrapper.style.setProperty('--absolute-height', `${size}px`);
            }
            
            // Handle blur container if enabled
            if (this.config.applyBlur) {
                const blurContainer = document.createElement("div");
                blurContainer.className = "blur-enabled";
                
                // Add logging to verify values
                console.log('Blur container config:', this.config.absoluteOptions.blurContainer);
                
                // Set blur container dimensions
                if (this.config.absoluteOptions.blurContainer) {
                    blurContainer.style.setProperty('--blur-width', 
                        `${this.config.absoluteOptions.blurContainer.width}px`);
                    blurContainer.style.setProperty('--blur-height', 
                        `${this.config.absoluteOptions.blurContainer.height}px`);
                    

                }
                
                const { photoBack, photoCurrent, videoCurrent } = this.createMediaElements();
                
                blurContainer.appendChild(photoBack);
                blurContainer.appendChild(photoCurrent);
                blurContainer.appendChild(videoCurrent);
                wrapper.appendChild(blurContainer);
            } else {
                const { photoBack, photoCurrent, videoCurrent } = this.createMediaElements();
                
                wrapper.appendChild(photoBack);
                wrapper.appendChild(photoCurrent);
                wrapper.appendChild(videoCurrent);
            }
        } else {
            const { photoBack, photoCurrent, videoCurrent } = this.createMediaElements();
            wrapper.appendChild(photoBack);
            wrapper.appendChild(photoCurrent);
            wrapper.appendChild(videoCurrent);
        }
        
        const attrContainer = document.createElement("div");
        attrContainer.className = "attribution-container";
        attrContainer.style.display = "none";
        const attrText = document.createElement("div");
        attrText.className = "attribution";
        attrContainer.appendChild(attrText);
        wrapper.appendChild(attrContainer);

        this._wrapper = wrapper;
        return wrapper;
    },

    displayMedia: function(media, wrapper) {
        const mediaType = this.getMediaType(media.key);
        
        if (mediaType === 'video' && this.config.video.enabled) {
            this.displayVideo(media, wrapper);
        } else {
            this.displayPhoto(media, wrapper);
        }
    },

    displayVideo: function(video, wrapper) {
        Log.debug(`[MMM-S3Photos] Preparing to show video: ${video.key}`);
        const videoElement = wrapper.querySelector('.video-current');
        const photoCurrent = wrapper.querySelector('.photo-current');
        const photoBack = wrapper.querySelector('.photo-back');
        
        if (!videoElement) {
            console.error("Video element not found in wrapper");
            return;
        }
        
        // Hide photo elements
        if (photoCurrent) photoCurrent.style.display = 'none';
        if (photoBack) photoBack.style.display = 'none';
        
        // Configure video element with performance optimizations
        videoElement.src = this.file(`cache/${video.key}`);
        videoElement.autoplay = this.config.video.autoplay;
        videoElement.muted = this.config.video.muted;
        videoElement.loop = this.config.video.loop;
        videoElement.controls = this.config.video.controls;
        
        // Performance optimizations for smooth playback
        videoElement.setAttribute('playsinline', '');
        videoElement.setAttribute('webkit-playsinline', '');
        
        if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
            const size = this.config.absoluteOptions.size || 400;
            
            if (this.config.absoluteOptions.side === "horizontal") {
                videoElement.style.maxWidth = `${size}px`;
                videoElement.style.height = 'auto';
                videoElement.style.width = '100%';
            } else {
                videoElement.style.maxHeight = `${size}px`;
                videoElement.style.width = 'auto';
                videoElement.style.height = '100%';
            }
        } else {
            videoElement.style.width = '100%';
            videoElement.style.height = '100%';
            videoElement.style.objectFit = this.config.displayStyle === "wallpaper" || this.config.displayStyle === "fill" ? 'cover' : 'contain';
        }
        
        if (this.config.video.muted) videoElement.setAttribute("muted", "");
        else videoElement.removeAttribute("muted");

        videoElement.addEventListener('loadeddata', () => {
            videoElement.style.display = 'block';

            this.updateAttribution(video, wrapper);
            this.imagesDisplayed++;

            if (!this.config.video.loop) {
                videoElement.addEventListener('ended', () => {
                    this.updateMedia();
                }, { once: true });
            }
        }, { once: true });

        videoElement.addEventListener('error', (e) => {
            console.error("Video failed to load:", video.key, e);
            this.updateMedia();
        }, { once: true });
        
        // Set up timer for next media (in case video is longer than display duration or loops)
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.updateMedia();
        }, this.config.displayDurationSeconds * 1000);
    },


    displayPhoto: function(photo, wrapper) {
        Log.debug(`[MMM-S3Photos] Preparing to show photo: ${photo.key}`);
        const hidden = new Image();
        hidden.src = this.file(`cache/${photo.key}`);
        
        const videoElement = wrapper.querySelector('.video-current');
        if (videoElement) {
            videoElement.style.display = 'none';
            videoElement.pause();
        }
        
        hidden.onload = () => {
            const photoCurrent = wrapper.querySelector('.photo-current');
            const photoBack = wrapper.querySelector('.photo-back');
            
            if (photoCurrent) photoCurrent.style.display = 'block';
            if (photoBack) photoBack.style.display = 'block';
            
            if (photoCurrent) {
                // Prevent rotation by ensuring dimensions are set before transition
                if (this.config.displayStyle === "absolute") {
                    const aspectRatio = hidden.width / hidden.height;
                    const size = this.config.absoluteOptions.size;
    
                    if (this.config.absoluteOptions.side === "horizontal") {
                        const calculatedHeight = Math.round(size / aspectRatio);
                        // IMPORTANT: Set dimensions first
                        photoCurrent.style.width = `${size}px`;
                        photoCurrent.style.height = `${calculatedHeight}px`;
                    } else {
                        const calculatedWidth = Math.round(size * aspectRatio);
                        photoCurrent.style.height = `${size}px`;
                        photoCurrent.style.width = `${calculatedWidth}px`;
                    }
                }
    
                // Apply the background images after dimensions are set
                // Set back layer first
                if (photoBack) {
                    photoBack.style.backgroundImage = `url(${hidden.src})`;
                }

                // Then set front layer
                requestAnimationFrame(() => {
                    // Reset the fade-in animation so it replays on every image swap
                    photoCurrent.classList.remove('animated');
                    void photoCurrent.offsetWidth; // force reflow to restart animation
                    photoCurrent.style.backgroundImage = `url(${hidden.src})`;

                    // Set background sizing
                    if (this.config.displayStyle === "absolute") {
                        photoCurrent.style.backgroundSize = "100% 100%";
                    } else if (this.config.displayStyle === "wallpaper" || this.config.displayStyle === "fill") {
                        photoCurrent.style.backgroundSize = "cover";
                    } else {
                        photoCurrent.style.backgroundSize = "contain";
                    }

                    photoCurrent.classList.add('animated');

                    // Update attribution immediately for all images
                    this.updateAttribution(photo, wrapper);

                    this.imagesDisplayed++;
                });
            }
    
            // Schedule next media
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.updateMedia();
            }, this.config.displayDurationSeconds * 1000);
        };
    
        hidden.onerror = () => {
            console.error("Failed to load image:", photo.key);
            this.updateMedia();
        };
    },

    file: function(relativePath) {
        // Helper function to convert module paths to absolute URLs
        relativePath = relativePath.replace(/^\//, '');
        return this.data.path + relativePath;
    },

    getStyles: function() {
        return ["MMM-S3Photos.css"];
    },

    scheduleNextPhoto: function() {
        Log.debug("Scheduling next media");
        if (this.timer) {
            clearTimeout(this.timer);
        }
        
        this.timer = setTimeout(() => {
            this.updateMedia();
        }, this.config.displayDurationSeconds * 1000);
        
        // Show first media immediately
        if (!this.currentPhoto) {
            this.updateMedia();
        }
    },



    updateMedia: function() {
        Log.debug("[MMM-S3Photos] Updating media");
        if (!this.photos || this.photos.length === 0) {
            console.log("No media available to display");
            return;
        }
    
        let nextIndex;
        switch (this.config.displayOrder) {
            case "random_dedupe": {
                if (this.dedupeQueue.length === 0) {
                    console.log("Dedupe queue exhausted, re-shuffling all media");
                    this.shownKeys = new Set();
                    this.dedupeQueue = this._shuffle(this.photos.map(p => p.key));
                    this._persistState();
                }

                const nextKey = this.dedupeQueue.shift();
                this.shownKeys.add(nextKey);
                this._persistState();

                const foundIdx = this.photos.findIndex(p => p.key === nextKey);
                nextIndex = foundIdx !== -1 ? foundIdx : Math.floor(Math.random() * this.photos.length);
                break;
            }
            case "random":
                nextIndex = Math.floor(Math.random() * this.photos.length);
                break;
            case "newest_first":
                nextIndex = (this.currentIndex + 1) % this.photos.length;
                break;
            case "oldest_first":
                nextIndex = (this.currentIndex + 1) % this.photos.length;
                break;
            default:
                nextIndex = (this.currentIndex + 1) % this.photos.length;
        }
    
        this.currentIndex = nextIndex;
        const nextMedia = this.photos[nextIndex];
        Log.debug(`[MMM-S3Photos] Loading media: ${nextMedia.key}`);
    
        // Update DOM
        if (this._wrapper) {
            this.displayMedia(nextMedia, this._wrapper);
        }
    },

    _loadDedupeQueue: function() {
        try {
            const saved = localStorage.getItem('MMM-S3Photos_dedupeQueue');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (e) { /* ignore */ }
        return [];
    },

    _saveDedupeQueue: function() {
        try {
            localStorage.setItem('MMM-S3Photos_dedupeQueue', JSON.stringify(this.dedupeQueue));
        } catch (e) { /* ignore */ }
    },

    _loadShownKeys: function() {
        try {
            const saved = localStorage.getItem('MMM-S3Photos_shownKeys');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) return new Set(parsed);
            }
        } catch (e) { /* ignore */ }
        return new Set();
    },

    _saveShownKeys: function() {
        try {
            localStorage.setItem('MMM-S3Photos_shownKeys', JSON.stringify([...this.shownKeys]));
        } catch (e) { /* ignore */ }
    },

    _persistState: function() {
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._saveDedupeQueue();
            this._saveShownKeys();
        }, 500);
    },

    _shuffle: function(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    },

    // Called whenever this.photos changes in random_dedupe mode.
    // - Drops keys no longer in the photo list (deleted assets).
    // - Appends newly discovered keys (shuffled) so they appear in the current cycle.
    _reconcileDedupeQueue: function() {
        const allKeysList = this.photos.map(p => p.key);
        const allKeys = new Set(allKeysList);

        // Drop removed assets from both structures
        this.dedupeQueue = this.dedupeQueue.filter(k => allKeys.has(k));
        this.shownKeys = new Set([...this.shownKeys].filter(k => allKeys.has(k)));

        // Only treat keys as new if they are not queued AND not already shown this cycle
        const queued = new Set(this.dedupeQueue);
        const newKeys = allKeysList.filter(k => !queued.has(k) && !this.shownKeys.has(k));

        if (newKeys.length > 0) {
            console.log(`Dedupe: appending ${newKeys.length} new asset(s) to queue`);
            this.dedupeQueue = this._shuffle(newKeys).concat(this.dedupeQueue);
        }

        this._saveDedupeQueue();
        this._saveShownKeys();
    },

    suspend: function() {
        // Handle module suspension
    },

    resume: function() {
        // Handle module resume
    },

    updateAttribution: function(photo, wrapper) {
        const attrContainer = wrapper.querySelector('.attribution-container');
        const attrText = wrapper.querySelector('.attribution');
        const folder = photo.key.split('/')[0];
        const text = this.config.attribution?.enabled && this.config.attribution.attributions[folder];

        if (text && attrContainer && attrText) {
            attrText.textContent = text;
            attrContainer.className = "attribution-container";
            attrContainer.setAttribute('data-relative', this.config.attribution.relativeTo || 'display');

            if (this.config.attribution.position === "dynamic") {
                if (!this.currentCorner) {
                    this.currentCorner = "top-left";
                } else {
                    switch (this.currentCorner) {
                        case "top-left": this.currentCorner = "top-right"; break;
                        case "top-right": this.currentCorner = "bottom-right"; break;
                        case "bottom-right": this.currentCorner = "bottom-left"; break;
                        case "bottom-left": this.currentCorner = "top-left"; break;
                    }
                }
                attrContainer.classList.add(this.currentCorner);
            } else {
                attrContainer.classList.add(this.config.attribution.corner || "bottom-right");
            }

            attrContainer.style.display = "block";
        } else if (attrContainer) {
            attrContainer.style.display = "none";
        }
    }

});