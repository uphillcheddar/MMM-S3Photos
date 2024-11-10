# Sample Configuration

Add the module to your `config.js` file:

```javascript
{
    module: "MMM-S3Photos",
    position: "fullscreen_below",    // standard Magic mirror regions (fullscreen_below should be used if setting wallpaper as display style)
    transitionDurationSeconds: 1.5, // How long (seconds) the transition animation takes
    config: {
        syncTimeHours: 1,           // How often to check for new photos (1 = hourly)
        cacheLifeDays: 0,           // 0 = never clean cache, otherwise days between cache purges
        displayDurationSeconds: 60,  // How long to show each photo
        
        // Display Style Options
        displayStyle: "absolute",   // Choose one:
                                    // "wallpaper" (fills entire screen)
                                    // "fill" (fills container region)
                                    // "fit-display" (maintains aspect ratio while filling display)
                                    // "absolute" (fixed size)
        applyBlur: false,           // Adds a blurred background in empty spaces
        // Only used when displayStyle is "absolute", omit if not using absolute mode
        absoluteOptions: {           
            enabled: false,
            side: "horizontal",      // "horizontal" = fixed width, "vertical" = fixed height
            size: 400,               // Size in pixels for the fixed dimension
            blurContainer: {
                width: 500,          // Only used if applyBlur is true and displayStyle is absolute
                height: 500          // Defines the size of the blur effect container
            }
        },
        // Photo Order Options
        displayOrder: "random",     // Choose one:
                                    // "random" (completely random)
                                    // "random_dedupe" (won't repeat until all photos are shown)
                                    // "newest_first" (chronological, newest photos first)
                                    // "oldest_first" (chronological, oldest photos first)
        // Attribution Settings
        attribution: {
            enabled: true,          
            attributions: {
                "samples": "Sample Photos by Pexels",     // In this example: "vacation_folder" is the folder name and "Summer 2023" will be displayed.
                "selfies": "Selfieshot Selfies"      // In this example: "family_folder" is the folder name and "Family Photos" will be displayed.
            },
            position: "static",      // "static" or "dynamic"
            corner: "bottom-right", // Only used if position is "static"
                                   // "top-left", "top-right", "bottom-left", "bottom-right"
            relativeTo: "display"   // Choose one:
                                   // "display" (relative to screen)
                                   // "image" (relative to photo boundaries)
                                   // "container" (relative to MM region)
        },
        selfieUploads: false,  // Whether to process and upload photos from MMM-Selfieshot
        selfieFolder: "selfies" // S3 folder name for selfieshot uploads
    }
}
```
