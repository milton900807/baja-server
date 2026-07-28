#!/bin/python
from requests import session


print ( '-------------------------- ')
auth_payload = {
    'email': 'jeffm@arcturusrx.com',
    'password': 'Arcturus$2020!'
}
query_payload = {
    'format': 'csv'
}
with session() as c:
    c.post('http://arcturus.discoverybase.net/db4/index.php/sessions/authenticate', data=auth_payload)
    response = c.post('http://arcturus.discoverybase.net/db4/index.php/api/get/get_all_plasmid_entity_ids', data=query_payload)
    print(response.headers)
    print(response.text)

