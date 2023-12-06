// app.js 
const sls = require('serverless-http');
const bodyParser = require('body-parser');
const express = require('express');
const app = express();
const AWS = require('aws-sdk');
const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
var cors = require('cors');
app.use(cors());
const SUBWAY_TABLE = process.env.SUBWAY_TABLE;
const CONGESTION_TABLE = process.env.CONGESTION_TABLE;
const EVENT_TABLE = process.env.EVENT_TABLE;
const EVENT_API_KEY = process.env.EVENT_API_KEY;
const dynamoDb = new AWS.DynamoDB.DocumentClient();
app.use(bodyParser.json({ strict: false }));

app.get('/test', async (req, res, next) => {
    res.status(200).send('Hello SNS-Serverless! : ');
});

app.get("/get-con", async function (req, res, next) {
    const lat = req.query.lat;
    const lon = req.query.lon;
    const TMAP_API_KEY = process.env.TMAP_API_KEY;
  
    var tmapRes = await axios.get(`https://apis.openapi.sk.com/tmap/geo/reverseLabel?version=1&format=json&callback=result&centerLat=${lat}&centerLon=${lon}&appKey=${TMAP_API_KEY}&reqCoordType=WGS84GEO&resCoordType=WGS84GEO&reqLevel=16`);
  
    var poiId = -1;
    if (tmapRes.status == 200) {
      poiId = tmapRes.data["poiInfo"]["id"];
    } else {
      return res.status(500).json({ "statusCode": "500", "message": "Tmap Geocoding API Error" });
    }
    if (poiId == -1) return res.status(500).json({ "statusCode": "500", "message": "Tmap Geocoding API Error" });
  
    // var hasValue = await findCongestion(poiId, new Date());
    // if (hasValue.length > 0) {
    //   return res.status(200).json(hasValue[0]);
    // }
  
    var poiRes = await axios.get(`https://apis.openapi.sk.com/tmap/puzzle/pois/${poiId}?format=json&appKey=${TMAP_API_KEY}&lat=${lat}&lng=${lon}`);
    if (poiRes.status == 200) {
      var content = poiRes.data["contents"]['rltm'][0];
      var date = content['datetime'];
      var congestion = content['congestion'];
      var congestionLevel = content['congestionLevel'];
      var type = content['type'];
      var dt = date.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3 $4:$5:$6');
  
      var congestionData = new Congestion({
        poiId: poiId,
        dateTime: dt,
        congestion: congestion,
        congestionLevel: congestionLevel,
        type: type,
      });
      // insertCongestion2DB(congestionData);
      return res.status(200).json(congestionData);
    }
  });

  class Congestion {
    constructor({ poiId, dateTime, congestion, congestionLevel, type }) {
      this.poiId = poiId;
      this.dateTime = dateTime;
      this.congestion = congestion;
      this.congestionLevel = congestionLevel;
      this.type = type;
    }
  }
  

  async function findCongestion(poiId, dateTime) {
    const params = {
      TableName: CONGESTION_TABLE,
      KeyConditionExpression: 'poiId = :poiId',
      FilterExpression: 'dateTime = :dateTime',
      ExpressionAttributeValues: {
        ':poiId': poiId,
        ':dateTime': dateTime.toISOString(),
      },
    };
  
    try {
      const result = await dynamoDb.query(params).promise();
      return result.Items;
    } catch (error) {
      console.error("Error while querying congestion from DynamoDB:", error);
      throw error;
    }
  };

  async function insertCongestion2DB(congestion) {
    const params = {
      TableName: CONGESTION_TABLE,
      Item: congestion,
    };
  
    try {
      await dynamoDb.put(params).promise();
      console.log("Congestion successfully inserted into the database");
    } catch (error) {
      console.error("Error while inserting congestion into DynamoDB:", error);
      throw error;
    }
  }

app.get("/get-stations", async function (req, res, next) {
    try {
        const params = {
            TableName: SUBWAY_TABLE,
        };

        const result = await dynamoDb.scan(params).promise();

        // DynamoDB 스캔 결과에서 Items 속성에 데이터가 있음
        const subways = result.Items;

        return res.status(200).json(subways);
    } catch (error) {
        console.error('지하철 역 조회 중 오류 발생:', error);
        return res.status(500).json({ error: '내부 서버 오류' });
    }
});


app.get("/get-event", async function (req, res, next) {
    const eventMonth = req.query.eventMonth;
    const targetDate = new Date(eventMonth);

    const params = {
        TableName: EVENT_TABLE,
        FilterExpression: 'eventStartDate <= :targetDate AND eventEndDate >= :targetDate',
        ExpressionAttributeValues: {
            ':targetDate': targetDate.toISOString(),
        },
    };
    try {
        const result = await dynamoDb.scan(params).promise();

        if (result.Items.length === 0) {
            const newEvents = await fetchEvent(eventMonth);
            await insertDB(newEvents);
            return res.status(200).json(newEvents);
        } else {
            console.log("Events already exist in the database");
            return res.status(200).json(result.Items);
        }
    } catch (error) {
        console.error("Error while querying events from DynamoDB:", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/insert-subway', async (req, res, next) => {
    // JSON 파일 읽기
    fs.readFile('input_mod.json', 'utf8', async (err, data) => {
        if (err) {
            console.error('파일을 읽는 중 오류 발생:', err);
            return;
        }
        const jsonData = JSON.parse(data);
        // 데이터 삽입 함수 호출
        insertSubwayData(jsonData);
    });
});

app.get("/init-event", async function (req, res, next) {
    const eventMonth = req.query.eventMonth;
    const promises = [];

    for (var i = 1; i <= 31; i++) {
        const targetString = `${eventMonth}-${i.toString().padStart(2, '0')}`;
        promises.push(fetchEvent(targetString));
    }
    var eventsData = [];
    try {
        eventsData = await Promise.all(promises);
        for (const newEvents of eventsData) {
            await insertDB(newEvents);
        }
        return res.status(200).json({ "statusCode": "200", "message": "행사 Data Insert complete", "data": eventsData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ "statusCode": "500", "message": "행사 Data Insert fail", "detailMessage": error.toString() });
    }
});


async function fetchEvent(eventString) {
    try {

        const API_URL = "http://api.data.go.kr/openapi/tn_pubr_public_pblprfr_event_info_api";

        axios.default.paramsSerializer = params => {
            return qs.stringify(params);
        }

        const params = {
            pageNo: 1,
            numOfRows: 100,
            type: 'json',
            eventStartDate: eventString,
        };

        const api_response = await axios.get(`${API_URL}?serviceKey=${EVENT_API_KEY}`, { params });
        console.log(`${API_URL}?serviceKey=${EVENT_API_KEY}${params}`)

        if (api_response.data.response.header['resultCode'] === "00") {
            return api_response.data.response.body.items;
        } else {
            return [];
        }
    } catch (error) {
        console.error("Error while fetching events:", error);
        throw error; // 예외를 상위로 전파하여 호출하는 곳에서 처리할 수 있도록 합니다.
    }
}
async function insertDB(newEvents) {
    const eventsArray = Array.isArray(newEvents) ? newEvents : [];
    const putRequests = newEvents.map(event => ({
        PutRequest: {
            Item: {
                eventNm: event.eventNm,
                opar: event.opar,
                eventCo: event.eventCo,
                eventStartDate: event.eventStartDate,
                eventEndDate: event.eventEndDate,
                eventStartTime: event.eventStartTime,
                eventEndTime: event.eventEndTime,
                chrgeInfo: event.chrgeInfo,
                mnnstNm: event.mnnstNm, // 수정된 속성 이름,
                auspcInsttNm: event.auspcInsttNm, // 수정된 속성 이름,
                phoneNumber: event.phoneNumber,
                suprtInsttNm: event.suprtInsttNm, // 수정된 속성 이름,
                seatNumber: event.seatNumber,
                admfee: event.admfee,
                entncAge: event.entncAge,
                dscntInfo: event.dscntInfo,
                atpn: event.atpn,
                homepageUrl: event.homepageUrl,
                advantkInfo: event.advantkInfo,
                prkplceYn: event.prkplceYn,
                rdnmadr: event.rdnmadr,
                lnmadr: event.lnmadr,
                latitude: event.latitude,
                longitude: event.longitude,
                referenceDate: event.referenceDate,
                insttCode: event.insttCode,
            }
        }
    }));

    const params = {
        RequestItems: {
            [EVENT_TABLE]: putRequests
        }
    };

    try {
        const result = await dynamoDb.batchWrite(params).promise();
        console.log("행사가 DynamoDB에 성공적으로 삽입되었습니다.", result);
    } catch (error) {
        console.error("행사를 DynamoDB에 삽입하는 중 오류 발생:", error);
    }
}

// {
//     "_id": "652d687032cf8e80211a2825",
//     "subwayLine": "1호선",
//     "stationName": "소요산역",
//     "stationCode": "100",
//     "lat": "37.9488749",
//     "lon": "127.0611591",
//     "__v": 0
// },
async function insertSubwayData(jsonData) {
    console.log(jsonData);

    // DynamoDB 배치 삽입용 배열 생성
    const putRequests = jsonData.contents.map(subway => ({
        PutRequest: {
            Item: {
                stationCode: subway.stationCode,
                stationName: subway.stationName,
                subwayLine: subway.subwayLine,
                lat: subway.lat,
                lon: subway.lon,
            },
        },
    }));

    // 배치 크기 조절을 위한 함수
    const chunkArray = (array, chunkSize) => {
        const result = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            result.push(array.slice(i, i + chunkSize));
        }
        return result;
    };

    // DynamoDB에 배치로 데이터 삽입
    const batchSize = 25; // 배치 크기 설정
    const batches = chunkArray(putRequests, batchSize);

    for (const batch of batches) {
        const params = {
            RequestItems: {
                [SUBWAY_TABLE]: batch,
            },
        };

        try {
            const result = await dynamoDb.batchWrite(params).promise();
            console.log('지하철이 DynamoDB에 성공적으로 삽입되었습니다.', result);

            // 처리되지 않은 항목이 있다면 재시도
            if (result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0) {
                console.log('일부 항목이 처리되지 않았습니다. 다시 시도합니다.');
            }
        } catch (error) {
            console.error('지하철을 DynamoDB에 삽입하는 중 오류 발생:', error);
        }
    }
}


module.exports.server = sls(app)