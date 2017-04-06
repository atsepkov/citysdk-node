/**
 * This is the Census module
 */

var _ = require('underscore');
var utils = require('./utils');
var Terraformer = require('terraformer');
Terraformer.ArcGIS = require('terraformer-arcgis-parser');


//Module object definition. Every module should have an "enabled" property and an "enable"  function.
function CensusModule() {
    this.enabled = false;
};

_this = new CensusModule();

const DEBUG = false;


/**
 * Prefetch zipcode lookup table for faster processing
 */
var zipCodeLookupTable = require('../assets/zip-code-details.json');

//Enable function. Stores the API key for this module and sets it as enabled
CensusModule.prototype.enable = function(apiKey) {
    this.apiKey = apiKey;
    this.enabled = true;
};

//After this point the module is all up to you

//Defaults
CensusModule.prototype.DEFAULT_YEAR = 2015;
CensusModule.prototype.DEFAULT_LEVEL = "place";
CensusModule.prototype.DEFAULT_API = "acs5";

//Global variables for supplemental georequests
CensusModule.prototype.SUPPLEMENTAL_REQUESTS_IN_FLIGHT = 0;


/**
 * ACS5 available years and the apis available with those years
 * @type {object} Properties of years with arrays of available APIs
 */
CensusModule.prototype.acsyears = {
    "1990": ["sf1", "sf3"],
    "2000": ["sf1", "sf3"],
    "2010": ["acs5"],
    "2011": ["acs5"],
    "2012": ["acs5", "acs3", "acs1"],
    "2013": ["acs5", "acs3", "acs1"],
    "2014": ["acs5", "acs1"],
    "2015": ["acs5", "acs1"]
};


/**
 * Dictionary of state codes to state capital coordinates. i.e. "AL" -> 32.3617, -86.2792
 * @type {object} Object with properties of state codes and values of arrays of coordinates
 */
CensusModule.prototype.stateCapitals = {
    "AL": [32.3617, -86.2792],
    "AK": [58.3, -134.4167],
    "AZ": [33.45, -112.0667],
    "AR": [34.6361, -92.3311],
    "CA": [38.5766, -121.4934],
    "CO": [39.7391, -104.9849],
    "CT": [41.7641, -72.6828],
    "DE": [39.1619, -75.5267],
    "DC": [38.9047, -77.0164],
    "FL": [30.4381, -84.2816],
    "GA": [33.7493, -84.3883],
    "HI": [21.3073, -157.8573],
    "ID": [43.6177, -116.1996],
    "IL": [39.7983, -89.6544],
    "IN": [39.7686, -86.1625],
    "IA": [41.5912, -93.6039],
    "KS": [39.0481, -95.6781],
    "KY": [38.1867, -84.8753],
    "LA": [30.4571, -91.1874],
    "ME": [44.3235, -69.7653],
    "MD": [38.9786, -76.4911],
    "MA": [42.3582, -71.0637],
    "MI": [42.7337, -84.5556],
    "MN": [44.9553, -93.1022],
    "MS": [32.2992, -90.1800],
    "MO": [38.5791, -92.1730],
    "MT": [46.5958, -112.0270],
    "NE": [40.8106, -96.6803],
    "NV": [39.1608, -119.7539],
    "NH": [43.2067, -71.5381],
    "NJ": [40.2237, -74.7640],
    "NM": [35.6672, -105.9644],
    "NY": [42.6525, -73.7572],
    "NC": [35.7806, -78.6389],
    "ND": [46.8133, -100.7790],
    "OH": [39.9833, -82.9833],
    "OK": [35.4822, -97.5350],
    "OR": [44.9308, -123.0289],
    "PA": [40.2697, -76.8756],
    "RI": [41.8236, -71.4222],
    "SC": [34.0298, -80.8966],
    "SD": [44.3680, -100.3364],
    "TN": [36.1667, -86.7833],
    "TX": [30.2500, -97.7500],
    "UT": [40.7500, -111.8833],
    "VT": [44.2500, -72.5667],
    "VA": [37.5333, -77.4667],
    "WA": [47.0425, -122.8931],
    "WV": [38.3472, -81.6333],
    "WI": [43.0667, -89.4000],
    "WY": [41.1456, -104.8019]
};

/**
 * Bounding box to allow users to request all geographies within the US, as there is no US boundary map server
 **/
var usBoundingBox = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [
                            -49.5703125,
                            41.77131167976407
                        ],
                        [
                            -152.2265625,
                            77.23507365492472
                        ],
                        [
                            -221.1328125,
                            19.973348786110602
                        ],
                        [
                            -135.703125,
                            -16.97274101999901
                        ],
                        [
                            -49.5703125,
                            41.77131167976407
                        ]
                    ]
                ]
            }
        }
    ]
};

/**
 * Dictionary of aliases, string alias -> object with variable and description
 * @type {object} Object with properties of aliased variable, each having an object specifying the api, true variable, and description
 */
CensusModule.prototype.aliases = require('../assets/census-variable-aliases.json');


/**
 * Begin utility functions
 */

/**
 * Checks to see if a string is in the aliases dictionary and returns the appropriate variable if so.
 * e.g. "income" will return "DP03_0064PE"
 * If the string is not in the alias dictionary, it will return the same string back. This is useful for parsing
 * user input. (Either a user requests a variable in the alias dictionary OR a specific variable)
 *
 * @param {string} aliasOrVariable A string to parse into a variable string.
 * @returns {string} Variable string
 */
CensusModule.prototype.parseToVariable = function(aliasOrVariable, dataset='acs') {
    //If the requested string is an alias, return the appropriate variable from the dictionary
    if(aliasOrVariable in this.aliases) {
        return this.aliases[aliasOrVariable].variable[dataset];
    }

    //Otherwise, this is either already a variable name or is unsupported
    return aliasOrVariable;
};

/**
 * Returns TRUE if the alias is normalizable (as marked in the alias dictionary), otherwise, false.
 * @param alias
 * @returns {boolean}
 */
CensusModule.prototype.isNormalizable = function(alias) {
    if(alias in this.aliases) {
        if("normalizable" in this.aliases[alias]) {
            if(this.aliases[alias].normalizable == true) {
                return true;
            }
        }
    }
    return false;
};

/**
 * Parses the state code in a request object, converting two letter state codes to lat/lng
 * @param request Object representing an api request
 */
CensusModule.prototype.parseRequestStateCode = function(request) {
    //This supports 2 letter state codes in a request
    if("state" in request) {
        if(isNaN(request.state)) {
            if(!("lat" in request) && !("lng" in request)) {
                request.lat = this.stateCapitals[request.state][0];
                request.lng = this.stateCapitals[request.state][1];
                delete request.state;
            } else {
                delete request.state;
            }
        }
    }
};

/**
 * Checks the request object for lat/lng latitude/longitude and x/y fields and moves them to the appropriate locations
 * for processing by the module
 * @param request Object representing an api request
 */
CensusModule.prototype.parseRequestLatLng = function(request) {
    //Check if we have latitude and longitude in the request
    //Allow the users to use either x,y; lat,lng; latitude,longitude to sepecify co-ordinates
    if(!("lat" in request)) {
        if("latitude" in request) {
            request.lat = request.latitude;
            delete request.latitude;
        } else if ("y" in request) {
            request.lat = request.y;
            delete request.y;
        }
    }

    if(!("lng" in request)) {
        if("longitude" in request) {
            request.lng = request.longitude;
            delete request.longitude;
        } else if("x" in request) {
            request.lng = request.x;
            delete request.x;
        }
    }
};

/**
 * Converts ESRI JSON to GeoJSON
 * @param esriJSON
 * @returns {{type: string, features: Array}}
 * @constructor
 */
CensusModule.prototype.ESRItoGEO = function(esriJSON) {
    var json = JSON.parse(esriJSON);
    var features = json.features;

    var geojson = {
        "type": "FeatureCollection",
        "features": []
    };

    for(var i = 0; i < features.length; i++) {
        features[i].spatialReference = json.spatialReference;
        geojson.features.push(Terraformer.ArcGIS.parse(features[i]));
    }

    return geojson;
};

/**
 * Converts geoJSON to ESRI Json
 * @param geoJSON
 * @returns {*}
 * @constructor
 */
CensusModule.prototype.GEOtoESRI = function(geoJSON) {
    return Terraformer.ArcGIS.convert(geoJSON);
};

/**
 * Downloads an ACS API's entire dictionary of variables from the Census
 * @param api
 * @param year
 * @param callback
 */
CensusModule.prototype.getACSVariableDictionary = function(api, year, callback) {
    var apiPattern = /({api})/;
    var yearPattern = /({year})/;

    var URL = "https://api.census.gov/data/{year}/{api}/variables.json";
    URL = URL.replace(apiPattern, api);
    URL = URL.replace(yearPattern, year);

    utils.ajaxRequest(URL, function(response) {
        response = JSON.parse(response);
        callback(response);
    } );
};

/**
 * End utility functions
 */

/**
 * Converts co-ordinates to Census FIPS via the Geocoder API
 *
 * @param {float} lat Latitude
 * @param {float} lng Longitude
 * @param {function} callback Callback function
 */
CensusModule.prototype.latLngToFIPS = function(lat, lng, callback) {
    var latPattern = /({lat})/;
    var lngPattern = /({lng})/;

    var geocoderURL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x={lng}&y={lat}&benchmark=4&vintage=4&layers=8,12,28,86,84&format=jsonp";

    //Insert our requested coordinates into the geocoder url
    geocoderURL = geocoderURL.replace(latPattern, lat);
    geocoderURL = geocoderURL.replace(lngPattern, lng);
    //Make our AJAX request
    var request = utils.jsonpRequest(geocoderURL, function(response) {
        //Call the callback
        if (!response) {
            // temporary debug logic
            console.log(geocoderURL);
            // try again
            request = utils.jsonpRequest(geocoderURL, function(response) {
                if (!response) {
                    console.log('...failed twice on ' + geocoderURL);
                } else {
                    callback(response.result.geographies);
                }
            });
        } else {
            callback(response.result.geographies);
        }
    });
};

/**
 * Converts a street address to Census FIPS via the Geocoder API
 *
 * Returns an array of matched addresses.
 *
 * @param street Street Address
 * @param city City
 * @param state State (2-Letter USPS Code)
 * @param callback Callback function
 */
CensusModule.prototype.addressToFIPS = function(street, city, state, callback) {
    var streetPattern = /({street})/;
    var cityPattern = /({city})/;
    var statePattern = /({state})/;

    //Geocoder URL for addresses
    var geocoderURL = "https://geocoding.geo.census.gov/geocoder/geographies/address?street={street}&city={city}&state={state}&benchmark=4&vintage=4&layers=8,12,28,86,84&format=jsonp&callback=?";

    //Replace with our data
    geocoderURL = geocoderURL.replace(streetPattern, street);
    geocoderURL = geocoderURL.replace(cityPattern, city);
    geocoderURL = geocoderURL.replace(statePattern, state);

    //This converts the spaces/weird characters into proper encoding so we don't break things
    geocoderURL = encodeURI(geocoderURL);

    //Make the call
    var request = utils.jsonpRequest(geocoderURL, function(response) {
        callback(response.result.addressMatches);
    });
};

/**
 * Converts a ZIP code to Lat/Lng and calls the callback on it.
 * @param zip {Number} 5 digit Zip code
 * @param callback
 */
CensusModule.prototype.zipToLatLng = function(zip, callback) {
    if (zipCodeLookupTable[zip]) {
        // use lookup table for the zipcode to lat,lng conversion
        callback({
            "lat": zipCodeLookupTable[zip].lat,
            "lng": zipCodeLookupTable[zip].lng
        });
    } else {
        // original logic that resolves zipcode manually
        var zipPattern = /({zip})/;

        var tigerURL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query?where=ZCTA5%3D{zip}&text=&objectIds=&time=&geometry=&geometryType=esriGeometryEnvelope&inSR=&spatialRel=esriSpatialRelIntersects&relationParam=&outFields=CENTLAT%2CCENTLON&returnGeometry=false&maxAllowableOffset=&geometryPrecision=&outSR=&returnIdsOnly=false&returnCountOnly=false&orderByFields=&groupByFieldsForStatistics=&outStatistics=&returnZ=false&returnM=false&gdbVersion=&returnDistinctValues=false&f=pjson";

        tigerURL = tigerURL.replace(zipPattern, zip);

        var request = utils.ajaxRequest(tigerURL, function(response) {
            var returnValue = {
                "lat": null,
                "lng": null
            };

            try {
                response = JSON.parse(response);

                if("features" in response) {
                    if(response.features.length > 0) {
                        returnValue.lat = response.features[0].attributes.CENTLAT;
                        returnValue.lng = response.features[0].attributes.CENTLON;
                    }
                }        
            } catch (e) {
                response = response;
            }

            callback(returnValue);
        });
    }
};


/**
 * Makes a request to the ACS5 Summary API. Should be used via apiRequest and not on its own, typically
 * @param {object} request JSON request (see apiRequest)
 * @param {function} callback
 */
CensusModule.prototype.acsSummaryRequest = function(request, callback) {
    var yearPattern = /({year})/;
    var apiPattern = /({api})/;
    var variablePattern = /({var})/;
    var blockGroupPattern = /({blockGroup})/;
    var statePattern = /({state})/;
    var countyPattern = /({county})/;
    var tractPattern = /({tract})/;
    var placePattern = /({place})/;
    var keyPattern = /({key})/;
    var qualifiersPattern = /({qualifiers})/;

    var qualifiers = "for=";
    var cascade = false;

    if(request.sublevel) {
        var level = (request.level == "blockGroup") ? "block+group" : request.level;
        switch(request.container) {
            case "us":
                qualifiers += level + ":*";
                break;
            case "place":
            case "state":
                qualifiers += level + ":*&in=state:{state}";
                if(request.level == "blockGroup") qualifiers += "+county:{county}";
                break;
            case "county":
                qualifiers += level + ":*&in=county:{county}+state:{state}";
                break;
            case "tract":
                qualifiers += level + ":*&in=tract:{tract}+county:{county}+state:{state}";
                break;
        }
    }

    //Only do this if the previous switch had no effect (i.e. no contianer)
    //TODO: Clean this up, unify with the above
    if(qualifiers == "for=") {
        switch(request.level) {
            case "us":
                //If sublevel, add the appropriate for and attach the in
                if(request.sublevel) {
                    qualifiers += "state:*";
                    cascade = true;
                } else {
                    qualifiers += "us:1";
                }
                break;
            case "blockGroup":
                if(request.sublevel) {
                    //Can't do this. No levels beneath. We'll set the sublevel to false here
                    request.sublevel = false;
                }
                qualifiers += "block+Group:{blockGroup}";
                if(!cascade) {
                    qualifiers += "&in=";
                    cascade = true;
                }
            case "tract":
                //If sublevel, add the appropriate for and attach the in
                //We also check the cascade tag so we don't do this twice.
                if(request.sublevel & !cascade) {
                    qualifiers += "block+Group:*&in=";
                    cascade = true;
                }

                qualifiers += "tract:{tract}";
                if(!cascade) {
                    qualifiers += "&in=";
                    cascade = true;
                } else {
                    qualifiers += "+";
                }
            case "county":
                //If sublevel, add the appropriate for and attach the in
                //We also check the cascade tag so we don't do this twice.
                if(request.sublevel & !cascade) {
                    qualifiers += "tract:*&in=";
                    cascade = true;
                }

                qualifiers += "county:{county}";
                if(!cascade) {
                    qualifiers += "&in=";
                    cascade = true;
                } else {
                    qualifiers += "+";
                }
            case "place":
                //If sublevel, add the appropriate for and attach the in
                //Check for cascade so we don't do this twice
                if(request.sublevel & !cascade) {
                    qualifiers += "place:*&in=";
                    cascade = true;
                } else if(!cascade) {
                    //We only use place in the for, for the moment
                    qualifiers += "place:{place}&in=";
                    cascade = true;
                }
            case "state":
                //If sublevel, add the appropriate for and attach the in
                //We also check the cascade tag so we don't do this twice.
                if(request.sublevel & !cascade) {
                    qualifiers += "county:*&in=";
                    cascade = true;
                }

                qualifiers += "state:{state}";
                break;
        }
    }

    //Construct the list of variables
    var variableString = "";

    for(var i = 0; i < request.variables.length; i++) {
        if(this.isNormalizable(request.variables[i])) {
            if(utils.inArray("population", request.variables) < 0) {
                //We have a variable that is normalizable, but no population in the request.
                //Grab the population
                request.variables.push("population");
            }
            //We have normalizable variables AND a request for population, we can break the for loop now
            break;
        }
    }

    var dataset = this.detectDataset(request);
    request.year = dataset.year;
    for(var i = 0; i < request.variables.length; i++) {
        if(i != 0) variableString += ",";
        variableString += this.parseToVariable(request.variables[i], dataset.variable);
    }

    //The URL for ACS5 request (summary file)
    var acsURL = "https://api.census.gov/data/{year}/{api}?get=NAME,{var}&{qualifiers}&key={key}";

    //Regex our URL to insert appropriate variables
    acsURL = acsURL.replace(qualifiersPattern, qualifiers);
    acsURL = acsURL.replace(apiPattern, request.api);
    acsURL = acsURL.replace(yearPattern, request.year);
    acsURL = acsURL.replace(variablePattern, variableString);
    acsURL = acsURL.replace(blockGroupPattern, request.blockGroup);
    acsURL = acsURL.replace(statePattern, request.state);
    acsURL = acsURL.replace(countyPattern, request.county);
    acsURL = acsURL.replace(tractPattern, request.tract);
    acsURL = acsURL.replace(placePattern, request.place);
    acsURL = acsURL.replace(keyPattern, this.apiKey);

    var request = utils.ajaxRequest(acsURL, function(response) {
        if (!response.length || /^error:/.test(response)) {
            callback({ error: "Bad response from Census server." });
        } else {
            //Turn it into json
            var jsonObject = JSON.parse(response);
            //Call the callback
            callback(jsonObject);
        }
    });
};

/**
 * Returns correct dataset based on request
 * @param request
 * @returns {object} Dataset parameters
 */
CensusModule.prototype.detectDataset = function(request) {
    // round to correct preset for earlier years
    var dataset, year, variableDataset;
    if (request.year < 2010) {
        dataset = 'sf1';
        year = request.year < 1995 ? 1990 : request.year < 2005 ? 2000 : request.year < 2010 ? 2010 : request.year;
        variableDataset = 'sf.' + year;
    } else {
        dataset = request.api || this.DEFAULT_API;
        year = request.year;
        variableDataset = 'acs';
    }

    return {
        api: dataset,
        year: year,
        variable: variableDataset
    };
};

/**
 * Makes a call to the Census TigerWeb API for Geometry.
 * Our spatial reference is 4326
 * @param request
 * @param callback
 */
CensusModule.prototype.tigerwebRequest = function(request, callback) {
    //This will ensure our coordinates come out properly
    var spatialReferenceCode = 4326;

    var servers = {
        current: {
            url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/{mapserver}/query",
            mapServers: {
                "state": 84,
                "county": 86,
                "tract": 8,
                "blockGroup": 10,
                "blocks": 12,
                "place": 28
            }
        },
        acs2014: {
            url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2014/MapServer/{mapserver}/query",
            mapServers: {
                "state": 82,
                "county": 84,
                "tract": 8,
                "blockGroup": 10,
                "place": 26
            }
        },
        acs2013: {
            url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2013/MapServer/{mapserver}/query",
            mapServers: {
                "state": 82,
                "county": 84,
                "tract": 8,
                "blockGroup": 10,
                "place": 26
            }
        },
        census2010: {
            url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2010/MapServer/{mapserver}/query",
            mapServers: {
                "state": 98,
                "county": 100,
                "tract": 14,
                "blockGroup": 16,
                "blocks": 18,
                "place": 34
            }
        }
    };

    var server = "current";
    if("mapServer" in request) {
        server = request.mapServer;
    } else {
        request.mapServer = "current";
    }

    //Dictionary of map server codes
    var mapServers = servers[server].mapServers;

    this.parseRequestStateCode(request);

    //Check for zip code
    if("zip" in request) {
        //We have zip code - but do we have lat/lng?
        if(!("lat" in request) || !("lng" in request)) {
            //We have the zip but no lat/lng - parse it and re-call
            this.zipToLatLng(request.zip, function(response) {
                request.lat = response.lat === null ? 0 : response.lat;
                request.lng = response.lng === null ? 0 : response.lng;
                if(!request.lat && !request.lng) {
                    request.data = []
                        callback(request);
                } else {
                    _this.apiRequest(request, callback);
                }
                return;
            });
        }
    }

    //Check for an address object
    if("address" in request) {
        //We have address - but do we have lat/lng?
        if(!("lat" in request) || !("lng" in request)) {
            //We have the address but no lat/lng - parse it and re-call
            this.addressToFIPS(request.address.street, request.address.city, request.address.state, function(response) {
                //Take the first matched address
                request.lat = response[0].coordinates.y;
                request.lng = response[0].coordinates.x;

                //Attach this "matched address" to the request address object so the user knows what we're using
                request.address.addressMatch = response[0];

                _this.tigerwebRequest(request, callback);
                return;
            })
        }
    }

    this.parseRequestLatLng(request);

    var mapserverPattern = /({mapserver})/;

    var tigerRequest = {
        f: "json",
        where: "",
        outFields: "*",
        outSR: spatialReferenceCode,
        inSR: spatialReferenceCode
    };

    tigerURL = servers[server].url;

    if("container" in request && "sublevel" in request) {
        if(!request.sublevel) {
            //They submitted a sublevel flag but it's false... remove the unnecessary flags and re-request
            delete request.sublevel;
            delete request.container;
            _this.tigerwebRequest(request, callback);
            return;
        }

        if(!("containerGeometry" in request)) {
            //We have a sublevel request with a container. We need to grab the container's geography and return it
            tigerURL = tigerURL.replace(mapserverPattern, mapServers[request.container]);
            tigerRequest.geometry = request.lng + "," + request.lat;
            tigerRequest.geometryType = "esriGeometryPoint";
            tigerRequest.spatialRel = "esriSpatialRelIntersects";

            utils.postRequest(tigerURL, tigerRequest, function(response) {
                // console.log(response);

                var json = JSON.parse(response);
                var features = json.features;
                //Grab our container ESRI geography, attach it to our request, and call this function again.
                if(request.container == "us") {
                    request.containerGeometry = _this.GEOtoESRI(usBoundingBox)[0].geometry;
                } else {
                    request.containerGeometry = features[0].geometry;
                }
                _this.tigerwebRequest(request, callback);
            });

            return;
        } else {
            //We have a sublevel request with a container, AND we've already grabbed the container's ESRI json
            tigerURL = tigerURL.replace(mapserverPattern, mapServers[request.level]);
            tigerRequest.geometry = JSON.stringify(request.containerGeometry);
            tigerRequest.geometryType = "esriGeometryPolygon";
            tigerRequest.spatialRel = (request.container == "place" || request.container == "geometry") ? "esriSpatialRelIntersects" : "esriSpatialRelContains";

            delete request.containerGeometry;

            utils.postRequest(tigerURL, tigerRequest, function(response) {
                callback(_this.ESRItoGEO(response));
            });
        }
    } else if ("sublevel" in request) {
        if(!request.sublevel) {
            //They submitted a sublevel flag but it's false... remove the unnecessary flags and re-request
            delete request.sublevel;
            delete request.container;
            _this.tigerwebRequest(request, callback);
            return;
        }
        //Sublevel, no container
        //Make the container equal to the level, and the sublevel
        request.container = request.level;
        switch(request.level) {
            case "us":
                request.level = "state";
                break;
            case "state":
                request.level = "county";
                break;
            case "county":
                request.level = "tract";
                break;
            case "place":
                request.level = "tract";
                break;
            case "tract":
                request.level = "blockGroup";
                break;
        };

        _this.tigerwebRequest(request, callback);
        return;
    } else {
        //We have a sublevel request with a container. We need to grab the container's geography and return it
        tigerURL = tigerURL.replace(mapserverPattern, mapServers[request.level]);
        tigerRequest.geometry = request.lng + "," + request.lat;
        tigerRequest.geometryType = "esriGeometryPoint";
        tigerRequest.spatialRel = "esriSpatialRelIntersects";

        utils.postRequest(tigerURL, tigerRequest, function(response) {
            callback(_this.ESRItoGEO(response));
        });
    }
};

/**
 * Processes a data request by looking at a JSON request
 *
 * JSON Requests should include:
 * "year" - Year of the request. See acs5years object for available years. Defaults to 2013 if not specified.
 * "lat" - Latitude of the requested location (either specified as x, lat, or latitude) NORTH
 * "lng" - Longitude of the requested location (either specified as y, lng, or longitude) EAST
 * "sublevel" - Defaults to "false". If set to "true", it will return the group of sublevels from the specified level.
 * "level" - Level of the request. Options are: blockGroup, tract, county, state, us. Will default to blockGroup.
 * "variables" - Array of variables either by alias or specific name
 *
 * exampleRequest = {
 *       "year": "2013",
 *       "lat": 38.9047,
 *       "lng": -77.0164,
 *       "level": "blockGroup"
 *       "variables": [
 *           "income"
 *       ]
 *   };
 *
 *   exampleResponse = {
 *       "year": "2013",
 *       "lat": 38.9047,
 *       "lng": -77.0164,
 *       "level": "blockGroup",
 *       "state": "11",
 *       "county": "001",
 *       "tract": "004701",
 *       "blockGroup": "2",
 *       "data": {
 *           "income": 33210
 *       }
 *   };
 *
 *   A response where you set sublevel to "true" will have an array in the data field instead of an object.
 *
 *
 *   Another example request:
 *
 *   {
 *      "state": "NY",
 *      "level": "state",
 *      "variables": [
 *          "income",
 *          "population"
 *      ]
 *   }
 *
 *   You could also send an address object to specify location
 *   {
 *      "address": {
 *          "street": "18 F Street NW"
 *          "city": "Washington",
 *          "state": "DC"
 *       }
 *
 *       "level": "blockGroup",
 *       "variables": [
 *          "population"
 *       ]
 *   }
 * @param {object} request The JSON object of the request
 * @param {function} callback A callback, which accepts a response parameter
 */
CensusModule.prototype.apiRequest = function(request, callback) {
    //Check for a year
    if(!("year" in request)) {
        request.year = this.DEFAULT_YEAR;
    }

    var dataset = _this.detectDataset(request);
    if(!("api" in request)) {
        request.api = dataset.api;
    } else {
        if(utils.inArray(request.api, this.acsyears[request.year]) < 0) {
            console.error("Warning: API " + request.api + " does not appear to support " + request.year);
        }
    }

    //Check for a level
    if(!("level" in request)) {
        request.level = this.DEFAULT_LEVEL;
    }

    //Check for sublevel flag
    if(!("sublevel" in request)) {
        request.sublevel = false;
    } else {
        //If we weren't given a boolean, convert the string to a boolean
        if(typeof request.sublevel !== typeof true) {
            if(request.sublevel == "true") {
                request.sublevel = true;
            } else {
                request.sublevel = false;
            }
        }
    }

    //Check for zip code
    if("zip" in request) {
        //We have zip code - but do we have lat/lng?
        if(!("lat" in request) || !("lng" in request)) {
            //We have the zip but no lat/lng - parse it and re-call
            this.zipToLatLng(request.zip, function(response) {
                request.lat = response.lat === null ? 0 : response.lat;
                request.lng = response.lng === null ? 0 : response.lng;
                if(!request.lat && !request.lng) {
                    request.data = [];
                    callback(request);
                } else {
                    _this.apiRequest(request, callback);
                }
            });
            return; // the callback will be handled asynchronously, skip the rest of the logic in this function
        }
    }

    //Check for an address object
    if("address" in request) {
        //We have address - but do we have lat/lng?
        if(!("lat" in request) || !("lng" in request)) {
            //We have the address but no lat/lng - parse it and re-call
            this.addressToFIPS(request.address.street, request.address.city, request.address.state, function(response) {
                //Take the first matched address
                request.lat = response[0].coordinates.y;
                request.lng = response[0].coordinates.x;

                //Attach this "matched address" to the request address object so the user knows what we're using
                request.address.addressMatch = response[0];

                _this.apiRequest(request, callback);
            })
            return; // the callback will be handled asynchronously, skip the rest of the logic in this function
        }
    }

    this.parseRequestStateCode(request);

    this.parseRequestLatLng(request);

    //Check if we have latitude/longitude values. If we do, call the geocoder and get the appropriate FIPS
    if("lat" in request && "lng" in request && !("geocoded" in request)) {
        this.latLngToFIPS(request.lat, request.lng, function(geographies) {
            if (DEBUG) {
                console.log(geographies);
            }

            //TODO: Expand this to support multiple blocks
            var fipsData = geographies["2010 Census Blocks"][0];
            request["state"] = fipsData["STATE"];
            request["county"] = fipsData["COUNTY"];
            request["tract"] = fipsData["TRACT"];
            request["blockGroup"] = fipsData["BLKGRP"];
            request["place"] = ("Incorporated Places" in geographies) ? (geographies["Incorporated Places"].length > 0) ? geographies["Incorporated Places"][0]["PLACE"] : null : null;
            request["place_name"] = ("Incorporated Places" in geographies) ? (geographies["Incorporated Places"].length > 0) ? geographies["Incorporated Places"][0]["NAME"] : null : null;

            request.geocoded = true;

            _this.apiRequest(request, callback);
        });
        return; //We return because the callback will fix our request into FIPs, and then call the request again
    }

    if("state" in request && "county" in request && "tract" in request && "blockGroup" in request) {
        if("variables" in request) {
            //If we don't have a data object in the request, create one
            if(!("data" in request)) request.data = [];

            //TODO: We need to create an algorithm to determine which API to call for which non-aliased variable
            //      right now everything is in acs5 summary so it doesn't matter.
            this.acsSummaryRequest(
                    request,
                    function(response) {
                        if(request.sublevel) {
                            //If sublevel is set to true, our "data" property will be an array of objects for each sublevel item.
                            request.data = [];
                            var currentVariable;
                            var currentResponseItem;
                            var currentDataObject;
                            for(var i = 1; i < response.length; i++) {
                                currentDataObject = {};
                                currentResponseItem = response[i];
                                currentDataObject["name"] = currentResponseItem[utils.inArray("NAME", response[0])];

                                var stateIndex = utils.inArray("state", response[0]);
                                var countyIndex = utils.inArray("county", response[0]);
                                var tractIndex = utils.inArray("tract", response[0]);
                                var blockGroupIndex = utils.inArray("block group", response[0]);
                                var placeIndex = utils.inArray("place", response[0]);

                                if(stateIndex >= 0) {
                                    currentDataObject["state"] = currentResponseItem[stateIndex];
                                }

                                if(countyIndex >= 0) {
                                    currentDataObject["county"] = currentResponseItem[countyIndex];
                                }

                                if(tractIndex >= 0) {
                                    currentDataObject["tract"] = currentResponseItem[tractIndex];
                                }

                                if(blockGroupIndex >= 0) {
                                    currentDataObject["blockGroup"] = currentResponseItem[blockGroupIndex];
                                }

                                if(placeIndex >= 0) {
                                    currentDataObject["place"] = currentResponseItem[placeIndex];
                                }

                                if (!response.error) {
                                    for(var j = 0; j < request.variables.length; j++) {
                                        currentVariable = request.variables[j];
                                        currentDataObject[currentVariable] = currentResponseItem[utils.inArray(_this.parseToVariable(currentVariable, dataset.variable), response[0])];

                                        if(_this.isNormalizable(currentVariable)) {
                                            currentDataObject[currentVariable + "_normalized"] = currentDataObject[currentVariable]/ currentResponseItem[utils.inArray(_this.parseToVariable("population", detectDataset.variable), response[0])]
                                        }

                                    }
                                }

                                request.data.push(currentDataObject);
                            }
                        } else {
                            //We don't have sublevel, so we just grab the single response
                            var currentVariable;
                            var currentDataObject = {};
                            if (!response.error) {
                                for(var i = 0; i < request.variables.length; i++) {
                                    currentVariable = request.variables[i];
                                    currentDataObject[currentVariable] = response[1][utils.inArray(_this.parseToVariable(currentVariable, dataset.variable), response[0])];

                                    if(_this.isNormalizable(currentVariable)) {
                                        currentDataObject[currentVariable + "_normalized"] = currentDataObject[currentVariable]/ response[1][utils.inArray(_this.parseToVariable("population", dataset.variable), response[0])]
                                    }

                                    //Move it into an array for consistency
                                    request.data = [];
                                    request.data.push(currentDataObject);

                                }
                            }
                        }

                        delete request.geocoded;
                        callback(request);
                    }
            );
        } else {
            //We have no variables remaining - use the callback on the request object
            callback(request);
            return;
        }
    } else {
        //Is the level the US?
        if(request.level == "us") {
            //Ok, let's just resubmit it with D.C. as the "state"
            request.state = "DC";
            _this.apiRequest(request, callback);
        }

        //We have some container geometry but no specific location, let the supplemental requests handle the variables
        if("containerGeometry" in request) {
            request.data = [];
            callback(request);
        }

        return;
    }
};


/**
 * Example request.
 *
 * {
 *      "lat": latitude,
 *      "lng": longitude,
 *      "sublevel": <optional> true/false,
 *      "container": <optional> place/county/state/tract
 *      "level": place/county/state/blockGroup/tract
 *      "variables": []
 *      "containerGeometry": <optional> Must have sublevel true and container flags, this value should be ESRI json and
 *                          marks the boundaries of the query region. You can convery geojson to ESRI via
 *                          CensusModule.prototype.GEOtoESRI
 *
 * }
 *
 * @param {object} request The JSON request
 * @param {function} callback The callback to take the response, which is geoJSON
 */
CensusModule.prototype.geoRequest = function(request, callback) {
    //Reference dictionary of levels -> geocoder response variables
    var comparisonVariables = {
        "tract": "TRACT",
        "place": "PLACE",
        "county": "COUNTY",
        "blockGroup": "BLKGRP"
    };

    //First - check if we have a data object in the request OR if we aren't requesting variables
    if("data" in request || !("variables" in request)) {
        //We have a data object for the request (or there isn't any requested), now we can get the geoJSON for the area
        if(!request.lat && !request.lng) {
            callback('error code');
        } else {
            _this.tigerwebRequest(request, function(response) {
                if(!("totals" in response)) {
                    response.totals = {};
                }
                //If we have data, let's attach it to the geoJSON
                if("data" in request) {
                    var totals = response.totals;
                    var features = response.features;
                    var data = request.data;
                    var variables = request.variables;

                    for(var i = 0; i < features.length; i++) {
                        matchedFeature = null;
                        //TODO: We need to tidy this grep up a bit.
                        matchedFeature = _.filter(data, function(e){
                            //Ensure we have a direct match for low level items by comparing the higher level items
                            if(request.level == "blockGroup" || request.level == "tract") {
                                return e[request.level] == features[i].properties[comparisonVariables[request.level]] &&
                                    e["tract"] == features[i].properties[comparisonVariables["tract"]] &&
                                    e["county"] == features[i].properties[comparisonVariables["county"]];
                            } else {
                                return e[request.level] == features[i].properties[comparisonVariables[request.level]];
                            }
                        });

                        if(matchedFeature.length == 0) {
                            //Sometimes cities span multiple counties. In this case, we sometimes miss data due to the
                            //limited nature of the Census API's geography hierarchy. This will issue supplemental requests
                            //to ensure we have data for all of our geojson entities
                            var suppRequest = {
                                "state": features[i].properties["STATE"],
                                "tract": features[i].properties["TRACT"],
                                "county": features[i].properties["COUNTY"],
                                "blockGroup": features[i].properties["BLKGRP"],
                                "place": features[i].properties["PLACE"],
                                "level": request.level,
                                "variables": variables,
                                "featuresIndex": i
                            };

                            CensusModule.prototype.SUPPLEMENTAL_REQUESTS_IN_FLIGHT++;
                            _this.apiRequest(suppRequest, function(resp) {
                                CensusModule.prototype.SUPPLEMENTAL_REQUESTS_IN_FLIGHT--;
                                for (var property in resp.data[0]) {
                                    if (resp.data[0].hasOwnProperty(property)) {
                                        features[resp.featuresIndex].properties[property] = resp.data[0][property];
                                        if(utils.inArray(property, variables) >= 0) totals[property] = Number(totals[property]) + (!isNaN(resp.data[0][property])) ? Number(resp.data[0][property]) : 0;
                                    }
                                }
                            });
                        } else if(matchedFeature.length == 1) {
                            //We have matched the feature's tract to a data tract, move the data over
                            matchedFeature = matchedFeature[0];
                            for (var property in matchedFeature) {
                                if (matchedFeature.hasOwnProperty(property)) {
                                    features[i].properties[property] = matchedFeature[property];
                                    if(utils.inArray(property, variables) >= 0) totals[property] = Number(totals[property]) + (!isNaN(matchedFeature[property])) ? Number(matchedFeature[property]) : 0;
                                }
                            }
                        } else {
                            //This usually occurs when a low-level geography entity isn't uniquely identified
                            //by the filter. We'll need to add more comparisons to the filter to clear this issue up.
                            console.log("Multiple matched features: " );
                            console.log(features[i]);
                            console.log(matchedFeature);
                        }
                    }
                }
                callback(response);
            });
        }
    } else {
        //We do not have the requested variables - let's get them
        _this.apiRequest(request, function(response) {
            _this.geoRequest(response, callback);
        });
    }
};

module.exports = _this;
