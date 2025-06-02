// --------------------------------------------------------------------------------
// Native JavaScript extensions

const photoshop = require("photoshop");
const core = photoshop.core;
const app = photoshop.app;
const imaging = photoshop.imaging;

// --------------------------------------------------------------------------------
// Image constants

// Maximum component value for the different bit depths
const kMax8Bit = 255;
const kMax16Bit = 32768;
const kMax32Bit = 1.0;	// HDR images can exceed 1.0

// --------------------------------------------------------------------------------
// This function divides a document into a series of tiles and invokes the provided handler
// for each tile.
// This is needed for operations that need to operate on all pixels in a document/layer.
// For such cases we cannot expect to be able to process all pixels in one operation as
// Photoshop documents can be very large

async function iteratePixels(document, layer, tileLength, effectHandler) {
    const documentID = document.id;
    const layerID = layer.id;

    const layerBounds = layer.boundsNoEffects;

    let width = layerBounds.width;
    let height = layerBounds.height;
    const right = layerBounds.right;
    const bottom = layerBounds.bottom;

    let top = layerBounds.top;
    while (top < bottom) {
        const remainingHeight = bottom - top;
        let height = Math.min(remainingHeight, tileLength);
        let left = layerBounds.left;
        while (left < right) {
            const remainingWidth = right - left;
            let width = Math.min(remainingWidth, tileLength);

            const sourceBounds = {"left": left, "top": top, "width": width, "height": height};
            await effectHandler(document, layer, sourceBounds);

            left += tileLength;
        }
        top += tileLength;
    }
}

// --------------------------------------------------------------------------------

async function redChannelHandler(document, layer, sourceBounds) {
    const documentID = document.id;
    const layerID = layer.id;

    // Get pixels from the current tile
    const pixelResult = await imaging.getPixels(
        {"documentID": documentID,
            "layerID": layerID,
            "sourceBounds": sourceBounds,
            "colorSpace": "RGB",
            "targetSize": {"height": sourceBounds.height}}
    );
    const imageData = pixelResult.imageData;
    const components = imageData.components;
    const componentSize = imageData.componentSize;
    const buffer = await imageData.getData();

    let newValue = 0;
    if (componentSize == 8) {
        newValue = kMax8Bit;
    } else if (componentSize == 16) {
        newValue = kMax16Bit;
    } else if (componentSize == 32) {
        newValue = kMax32Bit;
    } else {throw "Unknown componentSize"}

    // Modify pixels
    const width = imageData.width;
    const height = imageData.height;
    const pixelCount = width * height;
    for (let index = 0; index < pixelCount * components; index += components) {
        buffer[index] = newValue;	// set the first pixel value to max
    }

    // Create a new image object and assign pixels back to the target layer
    let options = {
        "width": width,
        "height": height,
        "components": components,
        "chunky": true,
        "colorProfile": imageData.colorProfile,
        colorSpace: "RGB"
    };
    let image = await imaging.createImageDataFromBuffer(buffer, options);
    await imaging.putPixels({"documentID": documentID,
        "layerID": layerID,
        "imageData": image,
        "replace": false,
        targetBounds: {"left": sourceBounds.left, "top": sourceBounds.top}});
    // Release image data immediately
    image.dispose();
}

// --------------------------------------------------------------------------------

async function desaturationHandler(document, layer, sourceBounds) {
    const documentID = document.id;
    const layerID = layer.id;
    const documentWidth = document.width;
    const documentHeight = document.height;

    // Get pixels from the current tile
    const pixelResult = await imaging.getPixels(
        {"documentID": documentID,
            "layerID": layerID,
            "sourceBounds": sourceBounds,
            "colorSpace": "RGB",
            "targetSize": {"height": sourceBounds.height}}
    );
    const imageData = pixelResult.imageData;
    const components = imageData.components;
    const componentSize = imageData.componentSize;
    const buffer = await imageData.getData();

    const width = imageData.width;
    const height = imageData.height;
    const right = sourceBounds.left + width;
    const bottom = sourceBounds.top + height;

    const componentCount = width * height;

    // compute the distance from center to corner
    const halfWidth = documentWidth / 2;
    const halfHeight = documentHeight / 2;

    // Use the smaller image dimension as the desatuation length
    const radius = Math.max(documentWidth, documentHeight) / 2;

    let pixelIndex = 0;
    for (let row = sourceBounds.top; row < bottom; ++row) {
        for (let col = sourceBounds.left; col < right; ++col) {
            let red = buffer[pixelIndex];
            let green = buffer[pixelIndex + 1];
            let blue = buffer[pixelIndex + 2];
            // ignore a possible alpha value

            const average = (red + green + blue) / 3;

            const xDist = col - halfWidth;
            const yDist = row - halfHeight;
            const distFromCenter = Math.sqrt(xDist * xDist + yDist * yDist);
            let fraction = (distFromCenter / radius);
            fraction = Math.min(fraction, 1);
            fraction = Math.max(fraction, 0);
            fraction = Math.pow(fraction, 2);

            buffer[pixelIndex] = red + fraction * (average - red);
            buffer[pixelIndex + 1] = green + fraction * (average - green);
            buffer[pixelIndex + 2] = blue + fraction * (average - blue);

            pixelIndex += components;
        }
    }

    let options = {
        "width": width,
        "height": height,
        "components": components,
        "chunky": true,
        "colorProfile": imageData.colorProfile,
        colorSpace: "RGB"
    };
    let image = await imaging.createImageDataFromBuffer(buffer, options);
    await imaging.putPixels({"documentID": documentID,
        "layerID": layerID,
        "imageData": image,
        "replace": false,
        targetBounds: {"left": sourceBounds.left, "top": sourceBounds.top}});
    // Release image data immediately
    image.dispose();
}

// --------------------------------------------------------------------------------

// Find the active document & layer and apply the provided effectHandler
// on the source pixels.

async function filterMain(executionContext, effectHandler) {
    let doc = app.activeDocument;
    if (doc === undefined) {throw "Missing document"}

    let layers = doc.activeLayers;
    if (layers === undefined || layers.length != 1) {throw "This filter needs a single selected layer"}
    
    let layer = layers[0];
    if (layer.kind != "pixel") {throw "The selected layer is not a pixel layer"}

    // Suspend history so all pixel modifications show up as a single
    // history state
    let historySuspension = await executionContext.hostControl.suspendHistory({"documentID": doc.id,
        "name": "JavaScript Pixel Filter"});

    // Process pixels in the document one tile at a time
    await iteratePixels(doc, layer, 500, effectHandler);

    // Resume the suspended history
    await executionContext.hostControl.resumeHistory(historySuspension, true);
}

// --------------------------------------------------------------------------------

/**
 *
 */
async function filterEffect(filterKind) {
    let filterHandler = undefined;
    try {
        if (filterKind == "redChannel") {
            let handler = async function (executionContext) {
                await filterMain(executionContext, redChannelHandler);
            };
            await core.executeAsModal(handler, {"commandName": "Full Red Channel"});
        } else if (filterKind == "desaturation") {
            let handler = async function (executionContext) {
                await filterMain(executionContext, desaturationHandler);
            };
            await core.executeAsModal(handler, {"commandName": "Radial Desaturation"});
        }
    } catch (e) {
        core.showAlert("Error: " + e);
    }
}

module.exports = {filterEffect};
